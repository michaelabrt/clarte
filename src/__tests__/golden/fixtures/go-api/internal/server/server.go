package server

import (
	"fmt"

	"github.com/example/go-api/internal/config"
	"github.com/example/go-api/internal/handlers"
	"github.com/example/go-api/internal/repository"
)

type Server struct {
	config  *config.Config
	handler *handlers.UserHandler
}

func New(cfg *config.Config) *Server {
	repo := repository.NewUserRepo()
	handler := handlers.NewUserHandler(repo)
	return &Server{config: cfg, handler: handler}
}

func (s *Server) Start() {
	fmt.Printf("Listening on %s\n", s.config.Addr)
}
