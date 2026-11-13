//! Registers the native Android helper plugin (`DomusPlugin.kt` in
//! gen/android): a foreground service that keeps hosted servers running in the
//! background, and screen capture via MediaProjection. The UI calls its
//! commands directly (`plugin:domus|…`); there is no Rust side to them.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Keeps the plugin handle alive for the lifetime of the app.
#[allow(dead_code)]
struct Handle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("domus")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("org.domus.app", "DomusPlugin")?;
                app.manage(Handle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
