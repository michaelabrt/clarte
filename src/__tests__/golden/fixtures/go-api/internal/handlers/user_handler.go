package handlers

import (
	"github.com/example/go-api/internal/models"
	"github.com/example/go-api/internal/repository"
)

type UserHandler struct {
	repo *repository.UserRepo
}

func NewUserHandler(repo *repository.UserRepo) *UserHandler {
	return &UserHandler{repo: repo}
}

func (h *UserHandler) GetUser(id int64) *models.User {
	return h.repo.FindByID(id)
}

func (h *UserHandler) CreateUser(name, email string) *models.User {
	user := models.NewUser(name, email)
	h.repo.Save(user)
	return user
}
