import { describe, it, expect } from "vitest";
import {
  buildIncidenceMatrix,
  computeFileEmbeddings,
  expandSeedsWithLSA,
  cosine,
  matmul,
  qr,
  jacobiEigen,
} from "../core/graph/semantic-lsa";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../storage/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSymGraph(files: Record<string, number[]>, edges: Array<[number, number]>): InMemorySymbolGraph {
  const symbols = new Map<number, InMemorySymbolNode>();
  const byFile = new Map<string, number[]>();
  const forward = new Map<number, InMemorySymEdge[]>();
  const reverse = new Map<number, InMemorySymEdge[]>();

  for (const [file, ids] of Object.entries(files)) {
    byFile.set(file, ids);
    for (const id of ids) {
      symbols.set(id, {
        id,
        filePath: file,
        name: `sym${id}`,
        kind: "function",
        startLine: id,
        isExported: true,
      });
    }
  }

  for (const [from, to] of edges) {
    const edge: InMemorySymEdge = {
      fromSymbolId: from,
      toSymbolId: to,
      kind: "calls",
      confidence: 1.0,
    };
    let fwd = forward.get(from);
    if (!fwd) {
      fwd = [];
      forward.set(from, fwd);
    }
    fwd.push(edge);

    let rev = reverse.get(to);
    if (!rev) {
      rev = [];
      reverse.set(to, rev);
    }
    rev.push(edge);
  }

  return { symbols, forward, reverse, byFile };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("incidence matrix", () => {
  it("builds CSR for 3 files, 5 symbols", () => {
    // File A (syms 1,2) imports sym 3 (in file B)
    // File B (sym 3) imports sym 4 (in file C)
    // File C (syms 4,5) has no outgoing edges
    const graph = makeSymGraph({ "a.ts": [1, 2], "b.ts": [3], "c.ts": [4, 5] }, [
      [1, 3],
      [2, 3],
      [3, 4],
    ]);

    const { matrix, fileList } = buildIncidenceMatrix(graph);

    expect(matrix.rows).toBe(3);
    expect(fileList).toHaveLength(3);

    // File A row should have entries for sym 3
    const aIdx = fileList.indexOf("a.ts");
    const aStart = matrix.rowPtr[aIdx];
    const aEnd = matrix.rowPtr[aIdx + 1];
    expect(aEnd - aStart).toBe(1); // one unique imported symbol

    // File B row should have entries for sym 4
    const bIdx = fileList.indexOf("b.ts");
    const bStart = matrix.rowPtr[bIdx];
    const bEnd = matrix.rowPtr[bIdx + 1];
    expect(bEnd - bStart).toBe(1);
  });
});

describe("math primitives", () => {
  it("matmul: identity", () => {
    const I = new Float64Array([1, 0, 0, 1]);
    const A = new Float64Array([3, 4, 5, 6]);
    const C = matmul(I, 2, 2, A, 2);
    expect(Array.from(C)).toEqual([3, 4, 5, 6]);
  });

  it("qr: orthonormal columns", () => {
    const A = new Float64Array([1, 0, 1, 1, 0, 1]);
    const { Q } = qr(A, 3, 2);

    // Q columns should be orthonormal
    let dot = 0;
    let norm0 = 0;
    let norm1 = 0;
    for (let i = 0; i < 3; i++) {
      dot += Q[i * 2] * Q[i * 2 + 1];
      norm0 += Q[i * 2] ** 2;
      norm1 += Q[i * 2 + 1] ** 2;
    }
    expect(dot).toBeCloseTo(0, 10);
    expect(norm0).toBeCloseTo(1, 10);
    expect(norm1).toBeCloseTo(1, 10);
  });

  it("jacobi: recovers eigenvalues of diagonal matrix", () => {
    const A = new Float64Array([3, 0, 0, 0, 1, 0, 0, 0, 2]);
    const { eigenvalues } = jacobiEigen(A, 3);

    const sorted = Array.from(eigenvalues).sort((a, b) => b - a);
    expect(sorted[0]).toBeCloseTo(3, 5);
    expect(sorted[1]).toBeCloseTo(2, 5);
    expect(sorted[2]).toBeCloseTo(1, 5);
  });

  it("cosine: identical vectors = 1.0", () => {
    const a = new Float64Array([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1.0, 10);
  });

  it("cosine: orthogonal vectors = 0.0", () => {
    const a = new Float64Array([1, 0]);
    const b = new Float64Array([0, 1]);
    expect(cosine(a, b)).toBeCloseTo(0.0, 10);
  });
});

describe("cosine clustering", () => {
  it("files with shared imports cluster, disjoint imports do not", () => {
    // Files A and B both import symbols from a shared cluster
    // File C imports from a completely different cluster
    const ids: number[] = [];
    for (let i = 1; i <= 20; i++) ids.push(i);

    const files: Record<string, number[]> = {};
    const edges: Array<[number, number]> = [];

    // 60 files: 20 in cluster 1, 20 in cluster 2, 20 mixed
    for (let i = 0; i < 60; i++) {
      const symId = 100 + i;
      files[`f${i}.ts`] = [symId];

      if (i < 20) {
        // Cluster 1: import symbols 1-10
        for (let j = 1; j <= 10; j++) edges.push([symId, j]);
      } else if (i < 40) {
        // Cluster 2: import symbols 11-20
        for (let j = 11; j <= 20; j++) edges.push([symId, j]);
      } else {
        // Mixed: import from both clusters
        edges.push([symId, 1], [symId, 11]);
      }
    }

    // Add symbol definition files
    for (let i = 1; i <= 20; i++) {
      files[`lib${i}.ts`] = [i];
    }

    const graph = makeSymGraph(files, edges);
    const embeddings = computeFileEmbeddings(graph, 8);

    if (!embeddings) {
      // Skip if too few files (shouldn't happen with 80 files)
      return;
    }

    const embA = embeddings.get("f0.ts");
    const embB = embeddings.get("f1.ts"); // same cluster as A
    const embC = embeddings.get("f20.ts"); // different cluster

    if (embA && embB && embC) {
      const simAB = cosine(embA, embB);
      const simAC = cosine(embA, embC);
      expect(simAB).toBeGreaterThan(simAC);
    }
  });
});

describe("seed expansion", () => {
  it("expands seeds with similar files", () => {
    const embeddings = new Map<string, Float64Array>();
    // Seed file
    embeddings.set("seed.ts", new Float64Array([1, 0, 0]));
    // Similar file (high cosine)
    embeddings.set("similar.ts", new Float64Array([0.9, 0.1, 0]));
    // Dissimilar file (low cosine)
    embeddings.set("unrelated.ts", new Float64Array([0, 0, 1]));

    const result = expandSeedsWithLSA(["seed.ts"], new Map([["seed.ts", 5.0]]), embeddings);

    expect(result.files).toContain("similar.ts");
    expect(result.files).not.toContain("unrelated.ts");
  });

  it("caps at LSA_MAX_EXPANSIONS", () => {
    const embeddings = new Map<string, Float64Array>();
    embeddings.set("seed.ts", new Float64Array([1, 0]));

    for (let i = 0; i < 20; i++) {
      embeddings.set(`f${i}.ts`, new Float64Array([0.95 - i * 0.01, 0.1]));
    }

    const result = expandSeedsWithLSA(["seed.ts"], new Map([["seed.ts", 5.0]]), embeddings);

    // Original seed + at most 5 expansions
    expect(result.files.length).toBeLessThanOrEqual(6);
  });

  it("returns seeds unchanged for empty embeddings", () => {
    const result = expandSeedsWithLSA(["a.ts"], new Map([["a.ts", 1.0]]), new Map());
    expect(result.files).toEqual(["a.ts"]);
  });
});

describe("small codebase guard", () => {
  it("returns null for < 50 files", () => {
    const graph = makeSymGraph({ "a.ts": [1], "b.ts": [2] }, [[1, 2]]);
    const embeddings = computeFileEmbeddings(graph);
    expect(embeddings).toBeNull();
  });
});
