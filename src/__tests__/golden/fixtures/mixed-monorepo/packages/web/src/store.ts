import type { Entity } from "../../core/src/types";
import { on } from "../../core/src/events";

const entities: Entity[] = [];

on("entity:created", (_event, payload) => {
  entities.push(payload as Entity);
});

export function getEntities(): Entity[] {
  return [...entities];
}

export function clearEntities(): void {
  entities.length = 0;
}
