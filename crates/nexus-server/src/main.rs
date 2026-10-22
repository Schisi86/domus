//! Headless NexusTalk server.
//!
//! ```text
//! nexustalk-server [--data <dir>]            run the server
//! nexustalk-server init [--data <dir>]       write a default server.toml
//! nexustalk-server backup [--data <dir>]     create a backup (server may be running)
//! nexustalk-server restore <file> [--data]   stage a backup; applied on next start
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use nexus_server::config::Config;

fn usage() {
    eprintln!(
        "NexusTalk-Server {}\n\n\
         Aufruf:\n  nexustalk-server [--data <verzeichnis>]\n  nexustalk-server init [--data <verzeichnis>]\n  \
         nexustalk-server backup [--data <verzeichnis>]\n  nexustalk-server restore <datei> [--data <verzeichnis>]\n\n\
         Standard-Datenverzeichnis: ./nexustalk-data (oder Umgebungsvariable NEXUSTALK_DATA)",
        nexus_server::VERSION
    );
}

struct Args {
    cmd: String,
    data: PathBuf,
    file: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let mut cmd = "run".to_string();
    let mut data = std::env::var_os("NEXUSTALK_DATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("nexustalk-data"));
    let mut file = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data" | "-d" => data = it.next().map(PathBuf::from).ok_or("--data erwartet ein Verzeichnis")?,
            "--help" | "-h" => cmd = "help".into(),
            "--version" | "-V" => cmd = "version".into(),
            "init" | "backup" | "run" => cmd = a,
            "restore" => {
                cmd = a;
                file = Some(it.next().map(PathBuf::from).ok_or("restore erwartet eine Sicherungsdatei")?);
            }
            other => return Err(format!("Unbekanntes Argument: {other}")),
        }
    }
    Ok(Args { cmd, data, file })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}\n");
            usage();
            return ExitCode::from(2);
        }
    };
    let cfg_path = args.data.join("server.toml");
    match args.cmd.as_str() {
        "help" => {
            usage();
            ExitCode::SUCCESS
        }
        "version" => {
            println!("{}", nexus_server::VERSION);
            ExitCode::SUCCESS
        }
        "init" => {
            if cfg_path.exists() {
                eprintln!("{} existiert bereits", cfg_path.display());
                return ExitCode::from(1);
            }
            if let Err(e) = std::fs::create_dir_all(&args.data).map_err(|e| e.to_string()).and_then(|_| Config::default().save(&cfg_path).map_err(|e| e.to_string())) {
                eprintln!("Fehler: {e}");
                return ExitCode::from(1);
            }
            println!("Konfiguration geschrieben: {}", cfg_path.display());
            ExitCode::SUCCESS
        }
        "backup" => {
            let db = nexus_server::db_path(&args.data);
            let out = args.data.join("backups").join(format!(
                "nexus-{}.db",
                nexus_server::maintenance::utc_stamp(nexus_server::util::now_ms())
            ));
            let res = std::fs::create_dir_all(args.data.join("backups")).map_err(|e| e.to_string()).and_then(|_| {
                let c = rusqlite::Connection::open(&db).map_err(|e| e.to_string())?;
                c.execute("VACUUM INTO ?1", rusqlite::params![out.to_string_lossy()]).map_err(|e| e.to_string())?;
                Ok(())
            });
            match res {
                Ok(()) => {
                    println!("Sicherung erstellt: {}", out.display());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Sicherung fehlgeschlagen: {e}");
                    ExitCode::from(1)
                }
            }
        }
        "restore" => {
            let file = args.file.expect("checked in parse_args");
            match nexus_server::maintenance::stage_restore_file(&file, &args.data) {
                Ok(()) => {
                    println!("Wiederherstellung vorbereitet. Sie wird beim nächsten Serverstart angewendet.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Wiederherstellung nicht möglich: {e}");
                    ExitCode::from(1)
                }
            }
        }
        _ => run(args.data, cfg_path).await,
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn run(data: PathBuf, cfg_path: PathBuf) -> ExitCode {
    if let Err(e) = std::fs::create_dir_all(&data) {
        eprintln!("Datenverzeichnis {} kann nicht angelegt werden: {e}", data.display());
        return ExitCode::from(1);
    }
    let mut _log_guard = None;
    loop {
        let cfg = match Config::load(&cfg_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("{} – {e}", cfg_path.display());
                return ExitCode::from(2);
            }
        };
        if !cfg_path.exists() {
            let _ = cfg.save(&cfg_path);
        }
        if _log_guard.is_none() {
            _log_guard = nexus_server::logbuf::init(Some(&data.join("logs")), "nexustalk-server", &cfg.log.level, cfg.log.max_files, true);
        }
        let server = match nexus_server::start(cfg, &data).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("{e}");
                eprintln!("Start fehlgeschlagen: {e}");
                return ExitCode::from(1);
            }
        };
        tokio::select! {
            _ = shutdown_signal() => {
                server.shutdown().await;
                return ExitCode::SUCCESS;
            }
            _ = server.restart_requested() => {
                tracing::info!("Neustart angefordert");
                server.shutdown().await;
            }
        }
    }
}
