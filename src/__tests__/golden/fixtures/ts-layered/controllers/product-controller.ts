import { getProduct, createProduct } from "../services/product-service";
import { formatProduct } from "../utils/format";
import { log } from "../utils/logger";

export function handleGetProduct(id: string): string {
  log(`GET /products/${id}`);
  const product = getProduct(id);
  return formatProduct(product);
}

export function handleCreateProduct(title: string, price: number): string {
  log(`POST /products`);
  const product = createProduct(title, price);
  return formatProduct(product);
}
