import { handleRequest } from "./api";

export function startServer(): void {
  const user = handleRequest("1");
  console.log(user);
}
