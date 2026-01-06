use crate::config::AppConfig;
use crate::models::user::User;
use crate::models::product::Product;

pub fn find_user(id: u64) -> Option<User> {
    let _cfg = AppConfig::load();
    Some(User::new("Test".to_string(), "test@example.com".to_string()))
}

pub fn find_product(id: u64) -> Option<Product> {
    let owner = User::new("Owner".to_string(), "owner@example.com".to_string());
    Some(Product::new("Widget".to_string(), 9.99, owner))
}
