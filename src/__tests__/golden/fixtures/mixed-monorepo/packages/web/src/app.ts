import { getEntities } from "./store";
import { formatEntity } from "../../core/src/utils";

export function renderEntities(): string[] {
  return getEntities().map(formatEntity);
}
