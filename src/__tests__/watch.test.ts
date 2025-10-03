import { describe, expect, it, vi } from "vitest";
import { shouldRebuild, createDebounce } from "../watch.js";

describe("shouldRebuild", () => {
  it("accepts TypeScript source files", () => {
    expect(shouldRebuild("src/index.ts")).toBe(true);
    expect(shouldRebuild("src/components/App.tsx")).toBe(true);
  });

  it("accepts JavaScript source files", () => {
    expect(shouldRebuild("src/utils.js")).toBe(true);
    expect(shouldRebuild("lib/helper.jsx")).toBe(true);
    expect(shouldRebuild("lib/module.mjs")).toBe(true);
  });

  it("accepts Python source files", () => {
    expect(shouldRebuild("src/main.py")).toBe(true);
  });

  it("accepts Go source files", () => {
    expect(shouldRebuild("pkg/server.go")).toBe(true);
  });

  it("accepts Rust source files", () => {
    expect(shouldRebuild("src/lib.rs")).toBe(true);
  });

  it("accepts Java source files", () => {
    expect(shouldRebuild("src/Main.java")).toBe(true);
  });

  it("rejects node_modules paths", () => {
    expect(shouldRebuild("node_modules/lodash/index.js")).toBe(false);
  });

  it("rejects dist paths", () => {
    expect(shouldRebuild("dist/index.js")).toBe(false);
  });

  it("rejects .git paths", () => {
    expect(shouldRebuild(".git/objects/abc123")).toBe(false);
  });

  it("rejects .clarte paths", () => {
    expect(shouldRebuild(".clarte/cache.json")).toBe(false);
  });

  it("rejects __pycache__ paths", () => {
    expect(shouldRebuild("__pycache__/module.cpython-39.pyc")).toBe(false);
  });

  it("rejects lock files", () => {
    expect(shouldRebuild("package-lock.json")).toBe(false);
    expect(shouldRebuild("pnpm-lock.yaml")).toBe(false);
    expect(shouldRebuild("yarn.lock")).toBe(false);
  });

  it("rejects non-source extensions", () => {
    expect(shouldRebuild("README.md")).toBe(false);
    expect(shouldRebuild("tsconfig.json")).toBe(false);
    expect(shouldRebuild("image.png")).toBe(false);
  });

  it("handles deeply nested ignored directories", () => {
    expect(shouldRebuild("packages/app/node_modules/pkg/index.ts")).toBe(false);
    expect(shouldRebuild("packages/app/dist/bundle.js")).toBe(false);
  });
});

describe("createDebounce", () => {
  it("collects items and fires after delay", async () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const debounced = createDebounce<string>(handler, 100);

    debounced.add("file1.ts");
    debounced.add("file2.ts");

    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(["file1.ts", "file2.ts"]);

    vi.useRealTimers();
  });

  it("resets timer on each new item", async () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const debounced = createDebounce<string>(handler, 100);

    debounced.add("file1.ts");
    vi.advanceTimersByTime(80);
    debounced.add("file2.ts");
    vi.advanceTimersByTime(80);

    // Should not have fired yet (timer was reset)
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(handler).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("flush triggers immediately", () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const debounced = createDebounce<string>(handler, 500);

    debounced.add("file1.ts");
    debounced.flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(["file1.ts"]);

    vi.useRealTimers();
  });

  it("flush does nothing when no pending items", () => {
    const handler = vi.fn();
    const debounced = createDebounce<string>(handler, 100);

    debounced.flush();
    expect(handler).not.toHaveBeenCalled();
  });
});
