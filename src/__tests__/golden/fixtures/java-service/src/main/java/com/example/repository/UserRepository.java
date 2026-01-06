package com.example.repository;

import com.example.model.User;

public class UserRepository {
    public User findById(Long id) {
        return new User("Test", "test@example.com");
    }

    public void save(User user) {
        // persist user
    }
}
