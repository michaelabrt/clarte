import { registerRoutes, type Route } from "../core/router";

export function featureC(): void {
  registerRoutes([
    { path: "/c/list", method: "GET" },
    { path: "/c/detail", method: "GET" },
  ]);
}
