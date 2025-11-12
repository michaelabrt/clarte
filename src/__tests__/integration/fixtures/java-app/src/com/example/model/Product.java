package com.example.model;

public class Product {
    private String id;
    private String title;
    private double price;

    public Product(String id, String title, double price) {
        this.id = id;
        this.title = title;
        this.price = price;
    }

    public String getId() { return id; }
    public String getTitle() { return title; }
    public double getPrice() { return price; }
}
