from .models import User, Config

def get_user(user_id: str, config: Config) -> User:
    return User(id=user_id, name="test")
