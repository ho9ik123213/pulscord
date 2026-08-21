#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pulscord_lib::run();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Pulscord");
}
