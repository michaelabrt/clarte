import type { BaseEntity } from "./index";

export class NotFoundError extends Error {
  constructor(public entity: string, public id: string) {
    super(`${entity} not found: ${id}`);
  }
}

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}
