import { describe, expect, it, vi, beforeEach } from "vitest";
import { inferConventions, renderConventionsSection } from "../conventions.js";
import type { ConfigConstraints, ImportGraph, InferredConventions } from "../types.js";

// Mock utils.ts to control file reads
vi.mock("../utils.js", () => ({
  readFileOr: vi.fn().mockResolvedValue(null),
}));

import { readFileOr } from "../utils.js";

const mockReadFileOr = vi.mocked(readFileOr);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeGraph(files: string[], edges: Array<{ from: string; to: string }>): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  for (const file of files) {
    inDegree.set(file, 0);
    centrality.set(file, 0.5);
    authority.set(file, 0.5);
    hubScores.set(file, 0.5);
  }

  const importEdges = edges.map((e) => ({
    from: e.from,
    to: e.to,
    isExternal: false,
    specifier: `./${e.to}`,
    importedNames: [],
  }));

  for (const edge of importEdges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  return {
    edges: importEdges,
    inDegree,
    centrality,
    externalImportCounts: new Map(),
    authority,
    hubScores,
  };
}

describe("inferConventions — naming", () => {
  it("detects camelCase functions and PascalCase types", async () => {
    const graph = makeGraph(["src/utils.ts", "src/types.ts"], []);

    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("utils.ts")) {
        return `
export function getUserById(id: string) {}
export function createUser(name: string) {}
export function deleteUser(id: string) {}
export function updateProfile(id: string) {}
export const MAX_RETRIES = 5;
export const API_BASE_URL = "https://api.example.com";
`;
      }
      if (filePath.endsWith("types.ts")) {
        return `
export type UserRole = "admin" | "user";
export interface UserProfile { name: string; }
export interface ApiResponse<T> { data: T; }
export enum StatusCode { Ok, Error }
`;
      }
      return null;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.naming.functions).toBe("camelCase");
    expect(result!.naming.types).toBe("PascalCase");
    expect(result!.naming.constants).toBe("UPPER_SNAKE_CASE");
  });

  it("detects snake_case functions (Python-style)", async () => {
    const graph = makeGraph(["src/utils.py"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function get_user_by_id(id) {}
export function create_user(name) {}
export function delete_user(id) {}
export function update_profile(id) {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.naming.functions).toBe("snake_case");
  });

  it("returns mixed when no dominant pattern", async () => {
    const graph = makeGraph(["src/a.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function getUser() {}
export function create_user() {}
export function DeleteUser() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.naming.functions).toBe("mixed");
  });
});

describe("inferConventions — export style", () => {
  it("detects named export preference", async () => {
    const graph = makeGraph(["src/a.ts", "src/b.ts", "src/c.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function foo() {}
export const bar = 42;
export type Baz = string;
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.exportStyle.preferNamed).toBe(true);
    expect(result!.exportStyle.defaultExportPercent).toBe(0);
  });

  it("detects default export usage", async () => {
    const graph = makeGraph(["src/a.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export default function App() {}
export const helper = () => {};
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.exportStyle.defaultExportPercent).toBe(50);
  });

  it("counts barrel files", async () => {
    const graph = makeGraph(["src/index.ts", "src/utils.ts"], []);

    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("index.ts")) {
        return `
export { foo } from './foo';
export { bar } from './bar';
export type { Baz } from './baz';
`;
      }
      return `
export function utils() {}
export const VALUE = 1;
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.exportStyle.barrelFileCount).toBe(1);
  });
});

describe("inferConventions — import ordering", () => {
  it("detects external-first with blank-line separation", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import path from "node:path";
import express from "express";

import { config } from "./config";
import { utils } from "./utils";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.importOrdering).toBe("external-first, blank-line separated");
  });

  it("detects external-first without separation", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import express from "express";
import { config } from "./config";
import { utils } from "./utils";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result!.importOrdering).toBe("external-first");
  });
});

describe("inferConventions — config constraint filtering", () => {
  it("skips naming when linter enforces naming conventions", async () => {
    const graph = makeGraph(["src/a.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function getUserById() {}
export type UserProfile = {};
`;
    });

    const constraints: ConfigConstraints = {
      linter: {
        tool: "ESLint",
        keyRules: [
          { rule: "@typescript-eslint/naming-convention", setting: "error", impact: "enforce naming conventions" },
        ],
      },
    };

    const result = await inferConventions("/test", graph, constraints);
    // Naming should be all "mixed" (cleared)
    if (result) {
      expect(result.naming.functions).toBe("mixed");
      expect(result.naming.types).toBe("mixed");
    }
  });

  it("skips import ordering when linter enforces it", async () => {
    const graph = makeGraph(["src/a.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import path from "node:path";

import { foo } from "./foo";

export function bar() {}
export type Baz = string;
`;
    });

    const constraints: ConfigConstraints = {
      linter: {
        tool: "ESLint",
        keyRules: [
          { rule: "import/order", setting: "error", impact: "keep imports sorted" },
        ],
      },
    };

    const result = await inferConventions("/test", graph, constraints);
    if (result) {
      expect(result.importOrdering).toBeUndefined();
    }
  });
});

describe("inferConventions — edge cases", () => {
  it("skips test and config files", async () => {
    const graph = makeGraph(["src/a.test.ts", "src/vitest.config.ts"], []);

    // Should not read test or config files for convention inference
    const result = await inferConventions("/test", graph);
    expect(result).toBeNull();
  });

  it("returns null for empty graph", async () => {
    const graph = makeGraph([], []);
    const result = await inferConventions("/test", graph);
    expect(result).toBeNull();
  });

  it("returns null when no identifiers found", async () => {
    const graph = makeGraph(["src/empty.ts"], []);
    mockReadFileOr.mockResolvedValue("// empty file\n");

    const result = await inferConventions("/test", graph);
    expect(result).toBeNull();
  });
});

describe("renderConventionsSection", () => {
  it("renders naming conventions", () => {
    const conventions: InferredConventions = {
      naming: {
        functions: "camelCase",
        types: "PascalCase",
        constants: "UPPER_SNAKE_CASE",
        files: "kebab-case",
      },
      exportStyle: {
        preferNamed: true,
        defaultExportPercent: 5,
        barrelFileCount: 0,
      },
    };

    const result = renderConventionsSection(conventions);
    expect(result).toContain("## Inferred Conventions");
    expect(result).toContain("camelCase for functions");
    expect(result).toContain("PascalCase for types");
    expect(result).toContain("UPPER_SNAKE_CASE for constants");
    expect(result).toContain("kebab-case for files");
  });

  it("renders export style", () => {
    const conventions: InferredConventions = {
      naming: { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" },
      exportStyle: {
        preferNamed: true,
        defaultExportPercent: 5,
        barrelFileCount: 3,
      },
    };

    const result = renderConventionsSection(conventions);
    expect(result).toContain("Named exports (no default exports)");
    expect(result).toContain("barrel files");
  });

  it("renders import ordering", () => {
    const conventions: InferredConventions = {
      naming: { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" },
      exportStyle: {
        preferNamed: true,
        defaultExportPercent: 0,
        barrelFileCount: 0,
      },
      importOrdering: "external-first, blank-line separated",
    };

    const result = renderConventionsSection(conventions);
    expect(result).toContain("external-first, blank-line separated");
  });

  it("returns null when all mixed", () => {
    const conventions: InferredConventions = {
      naming: { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" },
      exportStyle: {
        preferNamed: false,
        defaultExportPercent: 95,
        barrelFileCount: 0,
      },
    };

    const result = renderConventionsSection(conventions);
    expect(result).toBeNull();
  });
});
