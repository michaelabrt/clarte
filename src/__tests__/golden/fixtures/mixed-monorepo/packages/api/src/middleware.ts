import { delay } from "../../core/src/utils";

export async function rateLimiter(): Promise<boolean> {
  await delay(100);
  return true;
}

export function logger(method: string, path: string): void {
  console.log(`${method} ${path}`);
}
