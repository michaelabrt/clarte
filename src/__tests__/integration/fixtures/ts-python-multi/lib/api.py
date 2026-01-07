from .models import User
from .db import get_user

def handle_request(user_id: str) -> User:
    return get_user(user_id, None)
