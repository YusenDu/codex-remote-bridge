#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    codex_bridge_agent_lib::run();
}
