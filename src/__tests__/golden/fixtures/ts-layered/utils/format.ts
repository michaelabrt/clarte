import type { User, Product } from "../types/index";

export function formatUser(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function formatProduct(product: Product): string {
  return `${product.title} ($${product.price.toFixed(2)})`;
}

export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}
