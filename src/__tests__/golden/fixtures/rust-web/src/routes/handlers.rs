use crate::models::user::User;
use crate::db::queries;

pub fn handle_request() {
    let user = queries::find_user(1);
    let product = queries::find_product(1);
    println!("User: {:?}", user.map(|u| u.name));
    println!("Product: {:?}", product.map(|p| p.name));
}

pub fn create_user(name: String, email: String) -> User {
    User::new(name, email)
}
