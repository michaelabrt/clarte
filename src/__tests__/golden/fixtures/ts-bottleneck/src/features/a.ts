import { route, type Route } from "../core/router";
import { sanitize } from "../lib/utils";

export function featureA(input: string): unknown {
  const clean = sanitize(input);
  return route({ path: `/a/${clean}`, method: "GET" });
}
