package com.example.controller;

import com.example.model.User;
import com.example.service.UserService;

public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public User handleGetUser(Long id) {
        return userService.getUser(id);
    }

    public User handleCreateUser(String name, String email) {
        return userService.createUser(name, email);
    }
}
