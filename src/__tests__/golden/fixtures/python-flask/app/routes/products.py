from ..services.product_service import get_product, create_product
from ..services.auth import authenticate

products_bp = "products_blueprint"


def handle_get_product(product_id):
    product = get_product(product_id)
    return product.to_dict()


def handle_create_product(data):
    auth = authenticate(data.get("token"))
    return create_product(data["title"], data["price"])
