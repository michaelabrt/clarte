package repository

import (
	"github.com/example/go-api/internal/models"
)

type UserRepo struct {
	users map[int64]*models.User
}

func NewUserRepo() *UserRepo {
	return &UserRepo{users: make(map[int64]*models.User)}
}

func (r *UserRepo) FindByID(id int64) *models.User {
	return r.users[id]
}

func (r *UserRepo) Save(user *models.User) {
	r.users[user.ID] = user
}
