package com.example;

import com.example.config.AppConfig;
import com.example.service.UserService;
import com.example.controller.UserController;

public class App {
    public static void main(String[] args) {
        AppConfig config = new AppConfig();
        UserService userService = new UserService();
        UserController controller = new UserController(userService);
        System.out.println("Server started on " + config.getPort());
    }
}
