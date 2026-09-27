// Windows release builds must not pop a console window behind the dashboard. Debug builds keep
// it, because that is where the server's log output is most useful.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    localdrop_server_lib::run()
}
