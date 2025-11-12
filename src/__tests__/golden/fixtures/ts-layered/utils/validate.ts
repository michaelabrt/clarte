import type { BaseEntity } from "../types/index";
import { ValidationError } from "../types/errors";

export function validateId(entity: BaseEntity): boolean {
  if (!entity.id || entity.id.length === 0) {
    throw new ValidationError("id", "ID is required");
  }
  return true;
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
