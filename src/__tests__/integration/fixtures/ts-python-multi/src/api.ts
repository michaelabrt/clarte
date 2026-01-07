import type { User } from "./types";
import { getUser } from "./db";

export function handleRequest(id: string): User {
  return getUser(id, { dbUrl: "localhost", port: 5432 });
}
