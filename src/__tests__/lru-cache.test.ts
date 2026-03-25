import { describe, it, expect } from "vitest";
import { LRUCache } from "../core/lru-cache";

describe("LRUCache - basic get/set", () => {
  it("returns undefined for a missing key", () => {
    const cache = new LRUCache<string, number>(10);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns the stored value for a present key", () => {
    const cache = new LRUCache<string, number>(10);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("overwrites an existing key without growing the cache", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
    // Only one entry exists - overwrite should not consume extra capacity
    cache.set("b", 3);
    expect(cache.get("b")).toBe(3);
    expect(cache.get("a")).toBe(2);
  });
});

describe("LRUCache - eviction", () => {
  it("evicts the least recently used entry when capacity is exceeded", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // 'a' is LRU - adding 'c' must evict 'a'
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("promotes a get-accessed entry so it is not evicted first", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Accessing 'a' makes 'b' the LRU
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("evicts correctly with capacity 1", () => {
    const cache = new LRUCache<string, number>(1);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });
});

describe("LRUCache - clear", () => {
  it("makes all previously stored keys return undefined", () => {
    const cache = new LRUCache<string, number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("allows new entries after clear", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });
});

describe("LRUCache - non-string keys", () => {
  it("supports numeric keys", () => {
    const cache = new LRUCache<number, string>(5);
    cache.set(0, "zero");
    cache.set(1, "one");
    expect(cache.get(0)).toBe("zero");
    expect(cache.get(1)).toBe("one");
  });

  it("evicts with numeric keys", () => {
    const cache = new LRUCache<number, string>(2);
    cache.set(1, "one");
    cache.set(2, "two");
    cache.set(3, "three");
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(3)).toBe("three");
  });
});

describe("LRUCache - set promotion", () => {
  it("re-setting an existing key promotes it to MRU", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Re-set 'a' - it becomes MRU, 'b' becomes LRU
    cache.set("a", 10);
    cache.set("c", 3);
    // 'b' should be evicted
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(10);
    expect(cache.get("c")).toBe(3);
  });
});
