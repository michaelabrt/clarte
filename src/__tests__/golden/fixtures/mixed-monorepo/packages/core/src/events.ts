import type { EventHandler } from "./types";

const handlers: Map<string, EventHandler[]> = new Map();

export function on(event: string, handler: EventHandler): void {
  const list = handlers.get(event) ?? [];
  list.push(handler);
  handlers.set(event, list);
}

export function emit(event: string, payload: unknown): void {
  const list = handlers.get(event) ?? [];
  for (const handler of list) {
    handler(event, payload);
  }
}
