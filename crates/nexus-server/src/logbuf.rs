//! Logging setup: console, rotating files and an in-memory ring buffer that
//! admins can read through the API ("Serverprotokolle").

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const CAPACITY: usize = 1000;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Default)]
pub struct LogBuffer {
    lines: Mutex<VecDeque<LogLine>>,
}

impl LogBuffer {
    pub fn global() -> Arc<LogBuffer> {
        static B: OnceLock<Arc<LogBuffer>> = OnceLock::new();
        B.get_or_init(|| Arc::new(LogBuffer::default())).clone()
    }

    pub fn push(&self, line: LogLine) {
        let mut q = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= CAPACITY {
            q.pop_front();
        }
        q.push_back(line);
    }

    pub fn recent(&self, limit: usize, min_level: Option<Level>) -> Vec<LogLine> {
        let q = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        let iter = q.iter().filter(|l| match min_level {
            Some(min) => l.level.parse::<Level>().map(|lv| lv <= min).unwrap_or(true),
            None => true,
        });
        let mut v: Vec<LogLine> = iter.cloned().collect();
        let skip = v.len().saturating_sub(limit);
        v.drain(..skip);
        v
    }
}

struct BufferLayer(Arc<LogBuffer>);

struct MsgVisitor(String);

impl Visit for MsgVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0.insert_str(0, &format!("{value:?}"));
        } else {
            self.0.push_str(&format!(" {}={:?}", field.name(), value));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.insert_str(0, value);
        } else {
            self.0.push_str(&format!(" {}={}", field.name(), value));
        }
    }
}

impl<S: Subscriber> Layer<S> for BufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut v = MsgVisitor(String::new());
        event.record(&mut v);
        self.0.push(LogLine {
            ts: crate::util::now_ms(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            message: v.0,
        });
    }
}

/// Installs the global subscriber. Returns a guard that must be kept alive to
/// flush the file writer. Safe to call more than once (later calls are no-ops).
pub fn init(log_dir: Option<&Path>, prefix: &str, level: &str, max_files: usize, console: bool) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.set(()).is_err() {
        return None;
    }
    // Keep noisy dependencies quiet; the TURN stack logs every packet at debug.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("{level},turn=warn,webrtc_util=warn,hyper=warn,tower_http=warn")));
    let buffer = BufferLayer(LogBuffer::global());
    let mut guard = None;
    let file_layer = log_dir.and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(prefix)
            .filename_suffix("log")
            .max_log_files(max_files.max(1))
            .build(dir)
            .ok()?;
        let (nb, g) = tracing_appender::non_blocking(appender);
        guard = Some(g);
        Some(tracing_subscriber::fmt::layer().with_writer(nb).with_ansi(false))
    });
    let console_layer = console.then(|| tracing_subscriber::fmt::layer().with_target(false));
    let _ = tracing_subscriber::registry().with(filter).with(buffer).with(file_layer).with(console_layer).try_init();
    guard
}
