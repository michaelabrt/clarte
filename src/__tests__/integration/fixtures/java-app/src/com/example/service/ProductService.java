package com.example.service;

import com.example.model.Product;
import java.util.ArrayList;
import java.util.List;

public class ProductService {
    private final List<Product> products = new ArrayList<>();

    public List<Product> getAll() {
        return products;
    }

    public void addProduct(String id, String title, double price) {
        products.add(new Product(id, title, price));
    }
}
