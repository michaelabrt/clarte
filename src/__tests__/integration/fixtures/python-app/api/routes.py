from ..core.models import User
from ..core.utils import format_user


def get_user(user_id):
    user = User(user_id, "Test", "test@example.com")
    return format_user(user)
