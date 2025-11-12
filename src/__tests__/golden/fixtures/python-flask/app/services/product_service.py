from ..models.product import Product


def get_product(product_id):
    return Product(product_id, "Widget", 9.99)


def create_product(title, price):
    return Product("new", title, price)
