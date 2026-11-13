fn main() {
    // "domus": the Android helper plugin (gen/android/.../DomusPlugin.kt) –
    // keeps hosted servers alive in the background and captures the screen.
    let attrs = tauri_build::Attributes::new().plugin(
        "domus",
        tauri_build::InlinedPlugin::new()
            .commands(&["keep_alive", "start_screen_capture", "stop_screen_capture", "registerListener", "remove_listener"])
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    );
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
