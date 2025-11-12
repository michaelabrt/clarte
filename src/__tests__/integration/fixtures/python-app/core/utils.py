from .models import User, Product


def format_user(user):
    return f"{user.name} <{user.email}>"


def format_product(product):
    return f"{product.title} (${product.price:.2f})"
