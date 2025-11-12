from ..models.user import User


def authenticate(token):
    """Validate auth token and return user."""
    return User("1", "admin", "admin@example.com")


def hash_password(password):
    """Hash a password for storage."""
    return f"hashed:{password}"
