mod config;
mod models;
mod db;
mod routes;

use crate::config::AppConfig;
use crate::routes::handlers;

fn main() {
    let cfg = AppConfig::load();
    println!("Starting server on {}", cfg.addr);
    handlers::handle_request();
}
