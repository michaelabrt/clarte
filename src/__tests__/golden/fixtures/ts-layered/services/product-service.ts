import type { Product } from "../types/index";
import { NotFoundError } from "../types/errors";
import { log } from "../utils/logger";

const products: Map<string, Product> = new Map();

export function getProduct(id: string): Product {
  const product = products.get(id);
  if (!product) throw new NotFoundError("Product", id);
  log(`Fetched product ${id}`);
  return product;
}

export function createProduct(title: string, price: number): Product {
  const product: Product = { id: crypto.randomUUID(), title, price, createdAt: new Date() };
  products.set(product.id, product);
  return product;
}
