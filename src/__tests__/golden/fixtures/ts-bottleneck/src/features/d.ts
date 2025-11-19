import { route, type Route } from "../core/router";

export function featureD(): unknown {
  return route({ path: "/d", method: "POST" });
}
