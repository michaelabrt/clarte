package com.example.service;

import com.example.model.User;
import com.example.repository.UserRepository;

public class UserService {
    private final UserRepository repository = new UserRepository();

    public User getUser(Long id) {
        return repository.findById(id);
    }

    public User createUser(String name, String email) {
        User user = new User(name, email);
        repository.save(user);
        return user;
    }
}
