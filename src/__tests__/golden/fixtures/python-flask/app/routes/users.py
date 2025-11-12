from ..services.user_service import get_user, create_user
from ..services.auth import authenticate

users_bp = "users_blueprint"


def handle_get_user(user_id):
    user = get_user(user_id)
    return user.to_dict()


def handle_create_user(data):
    auth = authenticate(data.get("token"))
    return create_user(data["name"], data["email"], data["password"])
