import { connect, query } from "../lib/db";
import { getCache, setCache } from "../lib/cache";

export function handleRequest(path: string): unknown {
  const cached = getCache(path);
  if (cached) return cached.value;

  const conn = connect();
  const result = query(conn, `SELECT * FROM ${path}`);
  setCache({ key: path, value: result, ttl: 60 });
  return result;
}
