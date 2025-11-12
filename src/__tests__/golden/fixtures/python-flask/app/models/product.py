class Product:
    def __init__(self, id, title, price):
        self.id = id
        self.title = title
        self.price = price

    def to_dict(self):
        return {"id": self.id, "title": self.title, "price": self.price}
