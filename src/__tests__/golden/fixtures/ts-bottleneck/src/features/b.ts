import { route, type Route } from "../core/router";

export function featureB(): unknown {
  return route({ path: "/b", method: "GET" });
}
