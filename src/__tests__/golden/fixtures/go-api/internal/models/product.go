package models

import (
	"fmt"
)

type Product struct {
	ID    int64
	Name  string
	Price float64
	Owner *User
}

func NewProduct(name string, price float64, owner *User) *Product {
	return &Product{Name: name, Price: price, Owner: owner}
}

func (p *Product) String() string {
	return fmt.Sprintf("%s ($%.2f)", p.Name, p.Price)
}
