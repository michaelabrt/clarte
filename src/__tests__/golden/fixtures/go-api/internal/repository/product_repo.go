package repository

import (
	"github.com/example/go-api/internal/models"
)

type ProductRepo struct {
	products map[int64]*models.Product
}

func NewProductRepo() *ProductRepo {
	return &ProductRepo{products: make(map[int64]*models.Product)}
}

func (r *ProductRepo) FindByID(id int64) *models.Product {
	return r.products[id]
}

func (r *ProductRepo) Save(product *models.Product) {
	r.products[product.ID] = product
}
