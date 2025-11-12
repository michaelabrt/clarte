import type { User } from "../types/index";
import { NotFoundError } from "../types/errors";
import { validateEmail } from "../utils/validate";
import { log } from "../utils/logger";

const users: Map<string, User> = new Map();

export function getUser(id: string): User {
  const user = users.get(id);
  if (!user) throw new NotFoundError("User", id);
  log(`Fetched user ${id}`);
  return user;
}

export function createUser(name: string, email: string): User {
  if (!validateEmail(email)) throw new Error("Invalid email");
  const user: User = { id: crypto.randomUUID(), name, email, createdAt: new Date() };
  users.set(user.id, user);
  log(`Created user ${user.id}`);
  return user;
}
