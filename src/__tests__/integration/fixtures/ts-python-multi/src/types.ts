export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Config {
  dbUrl: string;
  port: number;
}
