import { getUser, createUser } from "../services/user-service";
import { formatUser } from "../utils/format";
import { log } from "../utils/logger";

export function handleGetUser(id: string): string {
  log(`GET /users/${id}`);
  const user = getUser(id);
  return formatUser(user);
}

export function handleCreateUser(name: string, email: string): string {
  log(`POST /users`);
  const user = createUser(name, email);
  return formatUser(user);
}
