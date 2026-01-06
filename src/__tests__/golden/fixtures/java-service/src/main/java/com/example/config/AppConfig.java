package com.example.config;

public class AppConfig {
    private int port = 8080;
    private String dbUrl = "jdbc:postgresql://localhost/app";

    public int getPort() {
        return port;
    }

    public String getDbUrl() {
        return dbUrl;
    }
}
