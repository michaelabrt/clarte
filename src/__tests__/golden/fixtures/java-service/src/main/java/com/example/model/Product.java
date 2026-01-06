package com.example.model;

import com.example.model.User;

public class Product {
    private Long id;
    private String name;
    private double price;
    private User owner;

    public Product(String name, double price, User owner) {
        this.name = name;
        this.price = price;
        this.owner = owner;
    }

    public Long getId() { return id; }
    public String getName() { return name; }
    public double getPrice() { return price; }
    public User getOwner() { return owner; }
}
