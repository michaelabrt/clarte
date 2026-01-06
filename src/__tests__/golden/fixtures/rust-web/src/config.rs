pub struct AppConfig {
    pub addr: String,
    pub db_url: String,
}

impl AppConfig {
    pub fn load() -> Self {
        AppConfig {
            addr: "0.0.0.0:8080".to_string(),
            db_url: "postgres://localhost/app".to_string(),
        }
    }
}
