import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../core/utils.js", async () => {
  const actual = await vi.importActual<typeof import("../core/utils.js")>("../core/utils.js");
  return {
    ...actual,
    readFileOr: vi.fn(),
  };
});

vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

vi.mock("../core/graph.js", async () => {
  const actual = await vi.importActual<typeof import("../core/graph.js")>("../core/graph.js");
  return {
    ...actual,
    findUsedExports: () => new Set<string>(),
  };
});

import { generateSnapshot } from "../core/snapshot/snapshot";
import { readFileOr } from "../core/utils";
import { glob } from "tinyglobby";
import type { DetectedContext } from "../core/types";

const mockReadFileOr = vi.mocked(readFileOr);
const mockGlob = vi.mocked(glob);

function makeTsCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test-project",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 5000,
    sourceFileCount: 10,
    monorepo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("JS/TS snapshot extraction", () => {
  it("extracts exported interfaces", async () => {
    const content = `export interface User {
  id: string;
  name: string;
  email: string;
}
`;

    mockGlob.mockResolvedValue(["src/types.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("interface User"));
    if (!entry) throw new Error("expected interface User entry");
    expect(entry.category).toBe("interface");
    expect(entry.signature).toContain("id: string");
    expect(entry.signature).toContain("email: string");
  });

  it("extracts exported type aliases", async () => {
    const content = `export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
`;

    mockGlob.mockResolvedValue(["src/types.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("type Result"));
    if (!entry) throw new Error("expected type Result entry");
    expect(entry.category).toBe("type");
    expect(entry.signature).toContain("Result<T>");
  });

  it("extracts exported function signatures (not bodies)", async () => {
    const content = `export async function fetchUser(id: string): Promise<User> {
  const resp = await fetch("/api/users/" + id);
  return resp.json();
}
`;

    mockGlob.mockResolvedValue(["src/api.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("fetchUser"));
    if (!entry) throw new Error("expected fetchUser entry");
    expect(entry.category).toBe("function");
    expect(entry.signature).toContain("async function fetchUser");
    expect(entry.signature).toContain("Promise<User>");
    // Should NOT contain the function body
    expect(entry.signature).not.toContain("fetch(");
    expect(entry.signature).not.toContain("resp.json");
  });

  it("extracts arrow function exports", async () => {
    const content = `export const greet = (name: string): string => {
  return "hello " + name;
};
`;

    mockGlob.mockResolvedValue(["src/utils.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("greet"));
    if (!entry) throw new Error("expected greet entry");
    expect(entry.category).toBe("function");
    expect(entry.signature).toContain("export const greet");
    // Should NOT contain the function body
    expect(entry.signature).not.toContain("hello");
  });

  it("skips non-function const exports", async () => {
    const content = `export const MAX_RETRIES = 3;
export const CONFIG = { port: 3000, host: "localhost" };
export const ITEMS = [1, 2, 3];
export const NAME = "test";
`;

    mockGlob.mockResolvedValue(["src/constants.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    // None of these should appear (they are plain value exports, not functions)
    expect(result.entries.find((e) => e.signature.includes("MAX_RETRIES"))).toBeUndefined();
    expect(result.entries.find((e) => e.signature.includes("CONFIG"))).toBeUndefined();
    expect(result.entries.find((e) => e.signature.includes("ITEMS"))).toBeUndefined();
    expect(result.entries.find((e) => e.signature.includes("NAME"))).toBeUndefined();
  });

  it("extracts exported enums", async () => {
    const content = `export enum Status {
  Active = "active",
  Inactive = "inactive",
  Pending = "pending",
}
`;

    mockGlob.mockResolvedValue(["src/types.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("enum Status"));
    if (!entry) throw new Error("expected enum Status entry");
    expect(entry.category).toBe("type");
    expect(entry.signature).toContain("Active");
    expect(entry.signature).toContain("Pending");
  });

  it("extracts export default function", async () => {
    const content = `export default function main(): void {
  console.log("hello");
}
`;

    mockGlob.mockResolvedValue(["src/index.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("main"));
    if (!entry) throw new Error("expected main entry");
    expect(entry.category).toBe("function");
    expect(entry.signature).toContain("export default function main");
    // Should NOT contain the body
    expect(entry.signature).not.toContain("console.log");
  });

  it("extracts export default class", async () => {
    const content = `export default class AppRouter {
  constructor(private routes: Route[]) {}

  resolve(path: string): Route | null {
    return this.routes.find(r => r.path === path) ?? null;
  }
}
`;

    mockGlob.mockResolvedValue(["src/router.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("AppRouter"));
    if (!entry) throw new Error("expected AppRouter entry");
    expect(entry.category).toBe("type");
    expect(entry.signature).toContain("class AppRouter");
  });

  it("skips re-exports (export { foo } from './other')", async () => {
    const content = `export { foo, bar } from "./other";
export { default as MyComponent } from "./component";
export * from "./utils";

export function localFunc(): void {
  console.log("local");
}
`;

    mockGlob.mockResolvedValue(["src/index.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    // Re-exports should not create entries
    expect(result.entries.find((e) => e.signature.includes("foo"))).toBeUndefined();
    expect(result.entries.find((e) => e.signature.includes("MyComponent"))).toBeUndefined();

    // Local declaration should still be extracted
    const localEntry = result.entries.find((e) => e.signature.includes("localFunc"));
    expect(localEntry).toBeDefined();
  });

  it("handles complex generic signatures correctly", async () => {
    const content = `export function merge<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  a: T,
  b: U,
): T & U {
  return { ...a, ...b };
}
`;

    mockGlob.mockResolvedValue(["src/utils.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("merge"));
    if (!entry) throw new Error("expected merge entry");
    expect(entry.category).toBe("function");
    // The signature should include the full generic parameters
    expect(entry.signature).toContain("T extends Record<string, unknown>");
    expect(entry.signature).toContain("U extends Record<string, unknown>");
    expect(entry.signature).toContain("T & U");
    // Should NOT contain body
    expect(entry.signature).not.toContain("...a");
  });

  it("handles overloaded function declarations", async () => {
    // In TS, overloads are declared with multiple signatures followed by implementation.
    // Each exported const is parsed as a separate declaration.
    const content = `export function process(input: string): string;
export function process(input: number): number;
export function process(input: string | number): string | number {
  return input;
}
`;

    mockGlob.mockResolvedValue(["src/utils.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    // Should find at least one "process" entry
    const processEntries = result.entries.filter((e) => e.signature.includes("process"));
    expect(processEntries.length).toBeGreaterThanOrEqual(1);
    expect(processEntries[0].category).toBe("function");
  });

  it("categorizes hooks correctly from hooks directory", async () => {
    const content = `export function useAuth(): { user: User | null; login: () => void } {
  return { user: null, login: () => {} };
}
`;

    mockGlob.mockResolvedValue(["src/hooks/useAuth.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx({ directories: ["src", "src/hooks"] }), []);

    const entry = result.entries.find((e) => e.signature.includes("useAuth"));
    if (!entry) throw new Error("expected useAuth entry");
    expect(entry.category).toBe("hook");
  });

  it("categorizes store types correctly", async () => {
    const content = `export interface AuthSlice {
  user: User | null;
  token: string | null;
}
`;

    mockGlob.mockResolvedValue(["src/stores/auth.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx({ directories: ["src", "src/stores"] }), []);

    const entry = result.entries.find((e) => e.signature.includes("AuthSlice"));
    if (!entry) throw new Error("expected AuthSlice entry");
    expect(entry.category).toBe("store");
  });

  it("extracts function expression exports", async () => {
    const content = `export const handler = function processRequest(req: Request): Response {
  return new Response("ok");
};
`;

    mockGlob.mockResolvedValue(["src/handler.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const entry = result.entries.find((e) => e.signature.includes("handler"));
    if (!entry) throw new Error("expected handler entry");
    expect(entry.category).toBe("function");
    // Should NOT contain body
    expect(entry.signature).not.toContain('Response("ok")');
  });

  it("handles JSX/TSX files", async () => {
    const content = `export interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}
`;

    // Not in a components dir, so Button should be extracted as a function
    mockGlob.mockResolvedValue(["src/Button.tsx"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx(), []);

    const interfaceEntry = result.entries.find((e) => e.signature.includes("interface ButtonProps"));
    if (!interfaceEntry) throw new Error("expected interface ButtonProps entry");
    expect(interfaceEntry.category).toBe("component");

    const funcEntry = result.entries.find((e) => e.signature.includes("function Button"));
    expect(funcEntry).toBeDefined();
  });

  it("extracts non-exported Props interface in component directories", async () => {
    const content = `interface CardProps {
  title: string;
  body: string;
}

export default function Card({ title, body }: CardProps) {
  return <div><h2>{title}</h2><p>{body}</p></div>;
}
`;

    mockGlob.mockResolvedValue(["src/components/Card.tsx"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    const result = await generateSnapshot(makeTsCtx({ directories: ["src", "src/components"] }), []);

    // Non-exported Props interface should be captured in component directories
    const propsEntry = result.entries.find((e) => e.signature.includes("interface CardProps"));
    if (!propsEntry) throw new Error("expected interface CardProps entry");
    expect(propsEntry.category).toBe("component");
  });

  it("handles files that cannot be parsed (graceful fallback)", async () => {
    // This content is not valid JS/TS but should not crash
    const content = `This is not valid JavaScript at all!!!
}{}{}{
@@@
`;

    mockGlob.mockResolvedValue(["src/broken.ts"] as string[]);
    mockReadFileOr.mockResolvedValue(content);

    // Should not throw; falls back to regex
    const result = await generateSnapshot(makeTsCtx(), []);
    // The fallback regex extractor may or may not find things, but it should not crash
    expect(result).toBeDefined();
    expect(result.entries).toBeDefined();
  });
});
