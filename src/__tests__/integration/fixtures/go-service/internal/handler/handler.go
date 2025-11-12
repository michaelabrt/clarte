package handler

import (
	"encoding/json"
	"net/http"
	"myapp/internal/store"
	"myapp/internal/model"
)

func GetUsers(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	user, ok := store.GetUser(id)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(user)
}

func CreateUser(w http.ResponseWriter, r *http.Request) {
	var req model.UserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusCreated)
}
