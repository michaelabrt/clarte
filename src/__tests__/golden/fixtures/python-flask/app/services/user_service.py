from ..models.user import User
from .auth import hash_password


def get_user(user_id):
    return User(user_id, "Test", "test@example.com")


def create_user(name, email, password):
    hashed = hash_password(password)
    return User("new", name, email)
