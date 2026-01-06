package models

type User struct {
	ID    int64
	Name  string
	Email string
}

func NewUser(name, email string) *User {
	return &User{Name: name, Email: email}
}
