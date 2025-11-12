import type { Entity } from "./types";

export function formatEntity(entity: Entity): string {
  return `${entity.name} (${entity.id})`;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
