package com.example.service;

import com.example.model.User;
import java.util.HashMap;
import java.util.Map;

public class UserService {
    private final Map<String, User> users = new HashMap<>();

    public User getUser(String id) {
        return users.get(id);
    }

    public void createUser(String id, String name, String email) {
        users.put(id, new User(id, name, email));
    }
}
