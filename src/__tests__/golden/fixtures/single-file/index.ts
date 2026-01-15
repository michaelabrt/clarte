export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export const VERSION = "1.0.0";

export interface Config {
  port: number;
  host: string;
}
