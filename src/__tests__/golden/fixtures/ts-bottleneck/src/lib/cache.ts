// Pure sink: no imports
export interface CacheEntry {
  key: string;
  value: unknown;
  ttl: number;
}

export function getCache(key: string): CacheEntry | null {
  return null;
}

export function setCache(entry: CacheEntry): void {}
