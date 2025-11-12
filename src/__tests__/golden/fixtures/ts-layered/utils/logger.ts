import type { Config } from "../types/index";

let config: Config | null = null;

export function initLogger(cfg: Config): void {
  config = cfg;
}

export function log(message: string): void {
  if (config?.debug) {
    console.log(`[DEBUG] ${message}`);
  }
}
