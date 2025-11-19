import { handleRequest } from "./handler";

export interface Route {
  path: string;
  method: string;
}

export function route(r: Route): unknown {
  return handleRequest(r.path);
}

export function registerRoutes(routes: Route[]): void {
  for (const r of routes) {
    route(r);
  }
}
