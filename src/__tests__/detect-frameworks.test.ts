import { describe, expect, it } from "vitest";
import {
  FRAMEWORK_MAP,
  PYTHON_FRAMEWORK_MAP,
  enrichFrameworksWithUsage,
  extractMavenVersion,
} from "../detect/frameworks.js";
import type { DetectedFramework } from "../types.js";

describe("FRAMEWORK_MAP", () => {
  it("is a non-empty record of dependency -> framework name", () => {
    const entries = Object.entries(FRAMEWORK_MAP);
    expect(entries.length).toBeGreaterThan(10);
    for (const [dep, name] of entries) {
      expect(typeof dep).toBe("string");
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("maps common JS frameworks", () => {
    expect(FRAMEWORK_MAP["react"]).toBe("React");
    expect(FRAMEWORK_MAP["vue"]).toBe("Vue");
    expect(FRAMEWORK_MAP["next"]).toBe("Next.js");
    expect(FRAMEWORK_MAP["express"]).toBe("Express");
    expect(FRAMEWORK_MAP["vitest"]).toBe("Vitest");
  });

  it("maps scoped packages", () => {
    expect(FRAMEWORK_MAP["@angular/core"]).toBe("Angular");
    expect(FRAMEWORK_MAP["@nestjs/core"]).toBe("NestJS");
    expect(FRAMEWORK_MAP["@trpc/server"]).toBe("tRPC");
    expect(FRAMEWORK_MAP["@prisma/client"]).toBe("Prisma");
  });

  it("deduplicates framework names for aliased deps", () => {
    // Both "prisma" and "@prisma/client" should map to "Prisma"
    expect(FRAMEWORK_MAP["prisma"]).toBe("Prisma");
    expect(FRAMEWORK_MAP["@prisma/client"]).toBe("Prisma");
  });
});

describe("PYTHON_FRAMEWORK_MAP", () => {
  it("maps common Python frameworks", () => {
    expect(PYTHON_FRAMEWORK_MAP["django"]).toBe("Django");
    expect(PYTHON_FRAMEWORK_MAP["flask"]).toBe("Flask");
    expect(PYTHON_FRAMEWORK_MAP["fastapi"]).toBe("FastAPI");
    expect(PYTHON_FRAMEWORK_MAP["pytest"]).toBe("pytest");
  });
});

describe("enrichFrameworksWithUsage", () => {
  it("enriches frameworks with import counts from graph", () => {
    const frameworks: DetectedFramework[] = [{ name: "React" }, { name: "Express" }];
    const externalImportCounts = new Map([
      ["react", 25],
      ["express", 3],
    ]);

    const result = enrichFrameworksWithUsage(frameworks, externalImportCounts);

    expect(result).toHaveLength(2);
    expect(result[0].importCount).toBe(25);
    expect(result[1].importCount).toBe(3);
  });

  it("sums counts across aliased deps for the same framework", () => {
    const frameworks: DetectedFramework[] = [{ name: "Prisma" }];
    const externalImportCounts = new Map([
      ["prisma", 2],
      ["@prisma/client", 10],
    ]);

    const result = enrichFrameworksWithUsage(frameworks, externalImportCounts);

    expect(result[0].importCount).toBe(12);
  });

  it("returns 0 import count when framework is not imported", () => {
    const frameworks: DetectedFramework[] = [{ name: "Tailwind CSS" }];
    const externalImportCounts = new Map<string, number>();

    const result = enrichFrameworksWithUsage(frameworks, externalImportCounts);

    expect(result[0].importCount).toBe(0);
  });

  it("preserves existing framework properties", () => {
    const frameworks: DetectedFramework[] = [{ name: "React", version: "18.2.0" }];
    const externalImportCounts = new Map([["react", 5]]);

    const result = enrichFrameworksWithUsage(frameworks, externalImportCounts);

    expect(result[0].version).toBe("18.2.0");
    expect(result[0].importCount).toBe(5);
  });

  it("handles empty frameworks array", () => {
    const result = enrichFrameworksWithUsage([], new Map());
    expect(result).toEqual([]);
  });
});

describe("extractMavenVersion", () => {
  it("extracts version from project-level version element", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.2.3</version>
</project>`;
    expect(extractMavenVersion(pom)).toBe("1.2.3");
  });

  it("extracts version from parent when no project version", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent</artifactId>
    <version>2.0.0</version>
  </parent>
  <artifactId>child</artifactId>
</project>`;
    expect(extractMavenVersion(pom)).toBe("2.0.0");
  });

  it("prefers project version over parent version", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>com.example</groupId>
    <version>1.0.0</version>
  </parent>
  <version>2.0.0</version>
</project>`;
    expect(extractMavenVersion(pom)).toBe("2.0.0");
  });

  it("returns undefined for pom without version", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>no-version</artifactId>
</project>`;
    expect(extractMavenVersion(pom)).toBeUndefined();
  });
});
