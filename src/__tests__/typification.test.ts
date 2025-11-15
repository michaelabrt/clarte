/**
 * Tests for R.2 Cartographic Typification.
 */

import { describe, expect, it } from "vitest";
import { typifyFiles, renderTypifiedKeyFiles, estimateTypificationSavings } from "../typification.js";
import type { HubFile, ImportEdge } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function hub(path: string, opts: Partial<HubFile> = {}): HubFile {
  return {
    path,
    centrality: opts.centrality ?? 0.5,
    authority: opts.authority ?? 0.5,
    hubScore: opts.hubScore ?? 0.5,
    role: opts.role ?? "Leaf",
    importedBy: opts.importedBy ?? 3,
    imports: opts.imports ?? 2,
  };
}

function edge(from: string, to: string): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: [], isTypeOnly: false, isDynamic: false };
}

// ── Grouping ─────────────────────────────────────────────────────────

describe("typifyFiles", () => {
  it("should group 3+ files in the same directory with the same role", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/products.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/orders.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/auth.ts", { role: "Leaf", importedBy: 1 }),
      hub("lib/db.ts", { role: "Foundation", importedBy: 10 }),
    ];
    const edges: ImportEdge[] = [
      edge("routes/users.ts", "lib/db.ts"),
      edge("routes/products.ts", "lib/db.ts"),
      edge("routes/orders.ts", "lib/db.ts"),
      edge("routes/auth.ts", "lib/db.ts"),
    ];

    const result = typifyFiles(files, edges);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].directory).toBe("routes");
    expect(result.groups[0].role).toBe("Leaf");
    expect(result.groups[0].members).toHaveLength(4);
    expect(result.ungrouped).toHaveLength(1);
    expect(result.ungrouped[0].path).toBe("lib/db.ts");
  });

  it("should not group fewer than minGroupSize files", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf" }),
      hub("routes/products.ts", { role: "Leaf" }),
      hub("lib/db.ts", { role: "Foundation" }),
    ];

    const result = typifyFiles(files, []);

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped).toHaveLength(3);
  });

  it("should respect custom minGroupSize", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf" }),
      hub("routes/products.ts", { role: "Leaf" }),
      hub("lib/db.ts", { role: "Foundation" }),
    ];

    const result = typifyFiles(files, [], { minGroupSize: 2 });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toHaveLength(2);
  });

  it("should not group files with different roles in the same directory", () => {
    const files = [
      hub("lib/db.ts", { role: "Foundation", importedBy: 10 }),
      hub("lib/utils.ts", { role: "Utility", importedBy: 8 }),
      hub("lib/auth.ts", { role: "Foundation", importedBy: 6 }),
      hub("lib/config.ts", { role: "Utility", importedBy: 4 }),
      hub("lib/cache.ts", { role: "Foundation", importedBy: 5 }),
    ];

    const result = typifyFiles(files, []);

    // 3 Foundation files should group, 2 Utility files should not (< minGroupSize)
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].role).toBe("Foundation");
    expect(result.groups[0].members).toHaveLength(3);
    expect(result.ungrouped).toHaveLength(2);
  });

  it("should mark outlier members as exceptions", () => {
    const files = [
      hub("pages/home.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      hub("pages/about.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      hub("pages/contact.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      // This one has wildly different authority
      hub("pages/dashboard.ts", { role: "Leaf", authority: 0.9, importedBy: 20 }),
    ];

    const result = typifyFiles(files, []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toHaveLength(3);
    expect(result.groups[0].exceptions).toHaveLength(1);
    expect(result.groups[0].exceptions[0].path).toBe("pages/dashboard.ts");
  });

  it("should extract common imports as traits", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf" }),
      hub("routes/products.ts", { role: "Leaf" }),
      hub("routes/orders.ts", { role: "Leaf" }),
    ];
    const edges: ImportEdge[] = [
      // All three import db.ts
      edge("routes/users.ts", "lib/db.ts"),
      edge("routes/products.ts", "lib/db.ts"),
      edge("routes/orders.ts", "lib/db.ts"),
      // Two of three import auth.ts
      edge("routes/users.ts", "lib/auth.ts"),
      edge("routes/orders.ts", "lib/auth.ts"),
    ];

    const result = typifyFiles(files, edges);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].traits.commonImports).toContain("lib/db.ts");
    expect(result.groups[0].traits.commonImports).toContain("lib/auth.ts");
  });

  it("should handle files in the root directory", () => {
    const files = [
      hub("app.ts", { role: "Orchestrator" }),
      hub("main.ts", { role: "Orchestrator" }),
      hub("server.ts", { role: "Orchestrator" }),
    ];

    const result = typifyFiles(files, []);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].directory).toBe(".");
  });
});

// ── Rendering ────────────────────────────────────────────────────────

describe("renderTypifiedKeyFiles", () => {
  it("should render groups as compact descriptions + file lists", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/products.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/orders.ts", { role: "Leaf", importedBy: 1 }),
      hub("lib/db.ts", { role: "Foundation", importedBy: 10 }),
    ];
    const edges: ImportEdge[] = [
      edge("routes/users.ts", "lib/db.ts"),
      edge("routes/products.ts", "lib/db.ts"),
      edge("routes/orders.ts", "lib/db.ts"),
    ];

    const result = typifyFiles(files, edges);
    const rendered = renderTypifiedKeyFiles(result, new Map());

    expect(rendered).toContain("## Key Files");
    // Ungrouped file should be in the table
    expect(rendered).toContain("lib/db.ts");
    // Group should be rendered as a compact description
    expect(rendered).toContain("3 leaf files");
    expect(rendered).toContain("`routes/`");
    // Individual filenames in the group
    expect(rendered).toContain("users.ts");
    expect(rendered).toContain("products.ts");
    expect(rendered).toContain("orders.ts");
    // Shared imports
    expect(rendered).toContain("lib/db.ts");
  });

  it("should include instability in individual file rows", () => {
    const files = [
      hub("lib/db.ts", { role: "Foundation", importedBy: 10 }),
      hub("lib/auth.ts", { role: "Foundation", importedBy: 5 }),
    ];

    const result = typifyFiles(files, []);
    const instMap = new Map([["lib/db.ts", 0.2]]);
    const rendered = renderTypifiedKeyFiles(result, instMap);

    expect(rendered).toContain("20% unstable");
  });

  it("should render exceptions as individual rows alongside ungrouped", () => {
    const files = [
      hub("pages/home.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      hub("pages/about.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      hub("pages/contact.ts", { role: "Leaf", authority: 0.01, importedBy: 1 }),
      hub("pages/dashboard.ts", { role: "Leaf", authority: 0.9, importedBy: 20 }),
    ];

    const result = typifyFiles(files, []);
    const rendered = renderTypifiedKeyFiles(result, new Map());

    // dashboard.ts is an exception, should be in the table
    expect(rendered).toContain("pages/dashboard.ts");
    // The 3 normal pages should be in a group
    expect(rendered).toContain("3 leaf files");
  });

  it("should return null for empty input", () => {
    const result = typifyFiles([], []);
    const rendered = renderTypifiedKeyFiles(result, new Map());
    expect(rendered).toBeNull();
  });
});

// ── Savings estimation ───────────────────────────────────────────────

describe("estimateTypificationSavings", () => {
  it("should report positive savings when groups are found", () => {
    const files = [
      hub("routes/users.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/products.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/orders.ts", { role: "Leaf", importedBy: 1 }),
      hub("routes/auth.ts", { role: "Leaf", importedBy: 1 }),
    ];

    const result = typifyFiles(files, []);
    const savings = estimateTypificationSavings(result, new Map());

    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.savedPct).toBeGreaterThan(0);
    expect(savings.typifiedTokens).toBeLessThan(savings.traditionalTokens);
  });

  it("should report zero savings when no groups exist", () => {
    const files = [
      hub("lib/db.ts", { role: "Foundation" }),
      hub("utils/helpers.ts", { role: "Utility" }),
    ];

    const result = typifyFiles(files, []);
    const savings = estimateTypificationSavings(result, new Map());

    expect(savings.savedTokens).toBe(0);
    expect(savings.savedPct).toBe(0);
  });
});
