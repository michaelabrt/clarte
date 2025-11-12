package main

import (
	"fmt"
	"net/http"
	"myapp/internal/handler"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/users", handler.GetUsers)
	fmt.Println("Server starting on :8080")
	http.ListenAndServe(":8080", mux)
}
