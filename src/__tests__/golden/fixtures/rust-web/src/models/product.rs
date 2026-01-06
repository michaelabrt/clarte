use super::user::User;

pub struct Product {
    pub id: u64,
    pub name: String,
    pub price: f64,
    pub owner: User,
}

impl Product {
    pub fn new(name: String, price: f64, owner: User) -> Self {
        Product { id: 0, name, price, owner }
    }
}
