import type { User, Config } from "./types";

export function getUser(id: string, config: Config): User {
  return { id, name: "test", email: "test@example.com" };
}
