from .api import handle_request
from .models import User

def start_server() -> None:
    user = handle_request("1")
    print(user)
