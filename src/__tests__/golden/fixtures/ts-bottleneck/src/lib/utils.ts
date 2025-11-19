import { query, type DbConnection } from "./db";

export function formatResult(conn: DbConnection, sql: string): string {
  const rows = query(conn, sql);
  return JSON.stringify(rows);
}

export function sanitize(input: string): string {
  return input.replace(/[<>]/g, "");
}
