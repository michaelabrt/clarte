import { createEntity, getEntity } from "./handler";
import { rateLimiter, logger } from "./middleware";

export async function handleRequest(method: string, path: string): Promise<unknown> {
  logger(method, path);
  await rateLimiter();

  if (method === "POST" && path === "/entities") {
    return createEntity("new");
  }
  if (method === "GET" && path.startsWith("/entities/")) {
    return getEntity(path.split("/")[2]);
  }
  return { status: 404 };
}
