use crate::models::user::User;

pub fn create_user(name: String, email: String) -> User {
    User::new(name, email)
}

pub fn get_user_name(user: &User) -> &str {
    &user.name
}
