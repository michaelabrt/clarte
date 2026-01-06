package main

import (
	"fmt"

	"github.com/example/go-api/internal/config"
	"github.com/example/go-api/internal/server"
)

func main() {
	cfg := config.Load()
	srv := server.New(cfg)
	fmt.Printf("Starting server on %s\n", cfg.Addr)
	srv.Start()
}
