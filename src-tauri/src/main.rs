// Vault's Rust shell is intentionally minimal for v1: it just hosts the
// local web frontend in a native window. All app logic, encryption, and
// storage happens on the frontend side (see js/crypto.js, js/storage.js).
//
// This keeps the security story simple and auditable: the thing that
// encrypts your data is the same ~150 lines of Web Crypto calls whether
// you run it in a browser tab or in this native shell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
