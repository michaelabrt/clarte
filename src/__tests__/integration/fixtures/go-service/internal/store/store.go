package store

import (
	"sync"
	"myapp/internal/model"
)

var (
	users = make(map[string]model.User)
	mu    sync.RWMutex
)

func GetUser(id string) (model.User, bool) {
	mu.RLock()
	defer mu.RUnlock()
	u, ok := users[id]
	return u, ok
}

func SaveUser(u model.User) {
	mu.Lock()
	defer mu.Unlock()
	users[u.ID] = u
}
