class User:
    def __init__(self, id: str, name: str):
        self.id = id
        self.name = name

class Config:
    def __init__(self, db_url: str):
        self.db_url = db_url
