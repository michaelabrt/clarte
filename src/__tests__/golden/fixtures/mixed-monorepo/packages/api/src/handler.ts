import type { ApiResponse, Entity } from "../../core/src/types";
import { generateId, formatEntity } from "../../core/src/utils";
import { emit } from "../../core/src/events";

export function createEntity(name: string): ApiResponse<Entity> {
  const entity: Entity = { id: generateId(), name };
  emit("entity:created", entity);
  return { data: entity, status: 201 };
}

export function getEntity(id: string): ApiResponse<string> {
  const entity: Entity = { id, name: "test" };
  return { data: formatEntity(entity), status: 200 };
}
