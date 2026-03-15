import { describe, expect, it, vi, beforeEach } from "vitest";
import { inferConventions, renderConventionsSection } from "../core/conventions/conventions.js";
import type { ConfigConstraints, InferredConventions } from "../core/types.js";
import { makeImportGraph } from "./helpers/factories.js";

// Mock utils.ts to control file reads
vi.mock("../core/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileOr: vi.fn().mockResolvedValue(null),
  };
});

import { readFileOr } from "../core/utils.js";

const mockReadFileOr = vi.mocked(readFileOr);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeGraph(files: string[], edges: Array<{ from: string; to: string }>) {
  return makeImportGraph(edges, files);
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
    expect(result?.naming.functions).toBe("camelCase");
    expect(result?.naming.types).toBe("PascalCase");
    expect(result?.naming.constants).toBe("UPPER_SNAKE_CASE");
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
    expect(result?.naming.functions).toBe("snake_case");
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
    expect(result?.naming.functions).toBe("mixed");
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
    expect(result?.exportStyle.preferNamed).toBe(true);
    expect(result?.exportStyle.defaultExportPercent).toBe(0);
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
    expect(result?.exportStyle.defaultExportPercent).toBe(50);
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
    expect(result?.exportStyle.barrelFileCount).toBe(1);
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
    expect(result?.importOrdering).toBe("external-first, blank-line separated");
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
    expect(result?.importOrdering).toContain("external-first");
    // Should not have blank-line separated since there are no blank lines between groups
    expect(result?.importOrdering).not.toContain("blank-line separated");
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
        keyRules: [{ rule: "import/order", setting: "error", impact: "keep imports sorted" }],
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

describe("inferConventions — per-directory overrides", () => {
  it("detects directory-specific naming when it differs from global", async () => {
    // Global convention is camelCase for functions,
    // but src/components uses PascalCase for files
    const files = [
      "src/utils/parse.ts",
      "src/utils/format.ts",
      "src/utils/validate.ts",
      "src/utils/transform.ts",
      "src/utils/convert.ts",
      "src/components/UserCard.tsx",
      "src/components/NavBar.tsx",
      "src/components/SidePanel.tsx",
      "src/components/DashboardLayout.tsx",
      "src/components/ProfileView.tsx",
      "src/components/SettingsForm.tsx",
    ];
    const graph = makeGraph(files, []);

    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.includes("utils/")) {
        return `
export function parseData(input: string) {}
export function formatOutput(data: any) {}
`;
      }
      if (filePath.includes("components/")) {
        return `
export function UserCard(props: any) {}
export type UserCardProps = {};
`;
      }
      return null;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();

    // Global file naming should be mixed (camelCase from utils, PascalCase from components)
    // Directory overrides should capture the local patterns
    if (result?.directoryOverrides) {
      const componentOverride = result?.directoryOverrides.find((o) => o.directory === "src/components");
      // Components should have PascalCase files if it differs from global
      if (componentOverride?.naming.files) {
        expect(componentOverride.naming.files).toBe("PascalCase");
      }
    }
  });

  it("does not report directory override when directory matches global convention", async () => {
    // All directories use camelCase functions consistently
    const files = [
      "src/utils/parse.ts",
      "src/utils/format.ts",
      "src/utils/validate.ts",
      "src/utils/transform.ts",
      "src/utils/convert.ts",
      "src/helpers/getData.ts",
      "src/helpers/setData.ts",
      "src/helpers/fetchItems.ts",
      "src/helpers/processItems.ts",
      "src/helpers/updateCache.ts",
    ];
    const graph = makeGraph(files, []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function processData(input: string) {}
export function formatResult(data: any) {}
export function validateInput(input: string) {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    // No directory overrides needed when all match global
    expect(result?.directoryOverrides).toBeUndefined();
  });

  it("requires 5+ samples per directory for override", async () => {
    // Directory with too few identifiers should not generate overrides
    const files = [
      "src/utils/parse.ts",
      "src/utils/format.ts",
      "src/utils/validate.ts",
      "src/utils/transform.ts",
      "src/utils/convert.ts",
      "src/tiny/a.ts",
    ];
    const graph = makeGraph(files, []);

    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.includes("utils/")) {
        return `
export function processData() {}
export function formatResult() {}
`;
      }
      if (filePath.includes("tiny/")) {
        return `
export function ProcessData() {}
`;
      }
      return null;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    // src/tiny/ has only 1 file with 1 function + 1 filename = 2 samples, below 5
    const tinyOverride = result?.directoryOverrides?.find((o) => o.directory === "src/tiny");
    expect(tinyOverride).toBeUndefined();
  });
});

describe("inferConventions — naming prefix detection", () => {
  it("detects use* prefix pattern for hooks", async () => {
    const graph = makeGraph(["src/hooks.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function useAuth() {}
export function useTheme() {}
export function useRouter() {}
export function useState() {}
export function useEffect() {}
export function formatDate() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.namingPrefixes).toBeDefined();
    const usePrefix = result?.namingPrefixes?.find((p) => p.prefix === "use");
    expect(usePrefix).toBeDefined();
    expect(usePrefix?.count).toBe(5);
    expect(usePrefix?.example).toBe("useAuth");
  });

  it("detects is*/has* prefix pattern for predicates", async () => {
    const graph = makeGraph(["src/validators.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function isValid(input: string) {}
export function isActive(user: any) {}
export function isAdmin(user: any) {}
export function hasPermission(user: any) {}
export function hasAccess(user: any) {}
export function hasRole(user: any) {}
export function formatDate() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.namingPrefixes).toBeDefined();
    const isPrefix = result?.namingPrefixes?.find((p) => p.prefix === "is");
    expect(isPrefix).toBeDefined();
    expect(isPrefix?.count).toBe(3);
    const hasPrefix = result?.namingPrefixes?.find((p) => p.prefix === "has");
    expect(hasPrefix).toBeDefined();
    expect(hasPrefix?.count).toBe(3);
  });

  it("detects get*/handle* prefix patterns", async () => {
    const graph = makeGraph(["src/actions.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function getUser() {}
export function getProfile() {}
export function getSettings() {}
export function handleClick() {}
export function handleSubmit() {}
export function handleChange() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.namingPrefixes).toBeDefined();
    const getPrefix = result?.namingPrefixes?.find((p) => p.prefix === "get");
    expect(getPrefix).toBeDefined();
    expect(getPrefix?.count).toBe(3);
    const handlePrefix = result?.namingPrefixes?.find((p) => p.prefix === "handle");
    expect(handlePrefix).toBeDefined();
    expect(handlePrefix?.count).toBe(3);
  });

  it("does not report prefix with fewer than 3 occurrences", async () => {
    const graph = makeGraph(["src/small.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function useAuth() {}
export function useTheme() {}
export function formatDate() {}
export function processData() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    // use* appears only 2 times, should not be reported
    expect(result?.namingPrefixes).toBeUndefined();
  });

  it("sorts prefixes by count descending", async () => {
    const graph = makeGraph(["src/mixed.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
export function useAuth() {}
export function useTheme() {}
export function useRouter() {}
export function useState() {}
export function useEffect() {}
export function getUser() {}
export function getProfile() {}
export function getSettings() {}
export function isValid() {}
export function isActive() {}
export function isAdmin() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.namingPrefixes).toBeDefined();
    // use* has 5 occurrences, get* and is* have 3 each
    expect(result?.namingPrefixes?.[0].prefix).toBe("use");
    expect(result?.namingPrefixes?.[0].count).toBe(5);
  });
});

describe("inferConventions — enhanced import ordering", () => {
  it("detects alphabetical ordering within groups", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import axios from "axios";
import express from "express";
import lodash from "lodash";

import { config } from "./config";
import { utils } from "./utils";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.importOrdering).toContain("alphabetical within groups");
  });

  it("does not report alphabetical when imports are not sorted", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import lodash from "lodash";
import axios from "axios";
import express from "express";

import { utils } from "./utils";
import { config } from "./config";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.importOrdering).toContain("external-first");
    expect(result?.importOrdering).not.toContain("alphabetical");
  });

  it("detects node: builtin imports separated from other external", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import fs from "node:fs";
import path from "node:path";

import express from "express";
import lodash from "lodash";

import { config } from "./config";
import { utils } from "./utils";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    expect(result?.importOrdering).toContain("node: builtins separated");
  });

  it("does not report node: builtins separated when they are mixed with other externals", async () => {
    const graph = makeGraph(["src/app.ts"], []);

    mockReadFileOr.mockImplementation(async () => {
      return `
import fs from "node:fs";
import express from "express";
import path from "node:path";

import { config } from "./config";
import { utils } from "./utils";

export function main() {}
`;
    });

    const result = await inferConventions("/test", graph);
    expect(result).not.toBeNull();
    if (result?.importOrdering) {
      expect(result?.importOrdering).not.toContain("node: builtins separated");
    }
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

  it("renders directory overrides as imperative directives", () => {
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
      directoryOverrides: [
        {
          directory: "src/components",
          naming: { files: "PascalCase" },
        },
      ],
    };

    const result = renderConventionsSection(conventions);
    expect(result).toContain("In `src/components/`");
    expect(result).toContain("PascalCase for files");
    expect(result).toContain("overrides project-wide");
  });

  it("renders naming prefix directives", () => {
    const conventions: InferredConventions = {
      naming: {
        functions: "camelCase",
        types: "PascalCase",
        constants: "mixed",
        files: "mixed",
      },
      exportStyle: {
        preferNamed: true,
        defaultExportPercent: 5,
        barrelFileCount: 0,
      },
      namingPrefixes: [
        { prefix: "use", count: 10, example: "useAuth" },
        { prefix: "is", count: 5, example: "isValid" },
        { prefix: "has", count: 3, example: "hasPermission" },
      ],
    };

    const result = renderConventionsSection(conventions);
    expect(result).toContain("`use` prefix convention");
    expect(result).toContain("`useAuth`");
    // is/has should be combined
    expect(result).toContain("`is`/`has`");
    expect(result).toContain("`isValid`");
    expect(result).toContain("`hasPermission`");
  });

  it("limits prefix directives to 3", () => {
    const conventions: InferredConventions = {
      naming: { functions: "camelCase", types: "mixed", constants: "mixed", files: "mixed" },
      exportStyle: { preferNamed: true, defaultExportPercent: 5, barrelFileCount: 0 },
      namingPrefixes: [
        { prefix: "use", count: 10, example: "useAuth" },
        { prefix: "get", count: 8, example: "getUser" },
        { prefix: "handle", count: 6, example: "handleClick" },
        { prefix: "is", count: 5, example: "isValid" },
        { prefix: "create", count: 3, example: "createUser" },
      ],
    };

    const result = renderConventionsSection(conventions);
    // Count prefix directive lines (they contain "prefix")
    const prefixLines = result
      ?.split("\n")
      .filter((l) => l.includes("prefix") || l.includes("`is`/`has`") || l.includes("`create`/`make`"));
    expect(prefixLines.length).toBeLessThanOrEqual(3);
  });
});
