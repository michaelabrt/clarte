// Pure sink: no imports
export interface DbConnection {
  host: string;
  port: number;
}

export function connect(): DbConnection {
  return { host: "localhost", port: 5432 };
}

export function query(conn: DbConnection, sql: string): unknown[] {
  return [];
}
