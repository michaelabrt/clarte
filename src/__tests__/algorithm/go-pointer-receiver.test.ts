/**
 * Verification tests for Go T vs *T method set distinction (audit Shift 3).
 *
 * Go spec:
 *   - Method set of T  = value-receiver methods only
 *   - Method set of *T = value-receiver + pointer-receiver methods
 *
 * A type T implicitly satisfies an interface I if T's method set >= I's method set.
 * A type *T satisfies I if *T's method set >= I's method set.
 *
 * When T has pointer-receiver methods, only *T satisfies interfaces requiring them.
 */

import { describe, expect, it } from "vitest";
import { buildGoTypeIndex, findSatisfiedInterfaces } from "../../core/graph/go-resolution";
import type { FileGraphResult } from "../../core/graph/symbol-types";
import type { SymbolIndex } from "../../core/graph/symbol-resolution";

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyResult(): FileGraphResult {
  return {
    imports: [],
    symbols: [],
    callSites: [],
    heritageChains: [],
    decorators: [],
    typeUsages: [],
    constructorAssignments: [],
    embeddings: [],
    implBlocks: [],
    typeAliases: [],
    semanticEdges: [],
  };
}

function buildIndex(
  symbols: Array<{ id: number; filePath: string; name: string; kind: string; startLine: number }>,
): SymbolIndex {
  const byFileAndName = new Map<
    string,
    Array<{ id: number; filePath: string; name: string; kind: string; startLine: number }>
  >();
  const byFile = new Map<
    string,
    Array<{ id: number; filePath: string; name: string; kind: string; startLine: number }>
  >();
  for (const s of symbols) {
    const key = `${s.filePath}::${s.name}`;
    let entries = byFileAndName.get(key);
    if (!entries) {
      entries = [];
      byFileAndName.set(key, entries);
    }
    entries.push(s);
    let fileEntries = byFile.get(s.filePath);
    if (!fileEntries) {
      fileEntries = [];
      byFile.set(s.filePath, fileEntries);
    }
    fileEntries.push(s);
  }
  return { byFileAndName, byFile };
}

// ── Test: Value receiver only ────────────────────────────────────────────────

describe("Go T vs *T method set distinction", () => {
  it("value-receiver-only type: both T and *T satisfy (receiverKind = 'value')", () => {
    // Struct Dog with value receivers only: Speak(), Name()
    // Interface Animal requires: Speak(), Name()
    // Both Dog and *Dog should satisfy Animal
    const fileGraphs = new Map<string, FileGraphResult>();

    const animalFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Animal", kind: "interface", startLine: 1, endLine: 5, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "Speak", kind: "method", startLine: 2, endLine: 2, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "Name", kind: "method", startLine: 3, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
      ],
    };

    const dogFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Dog", kind: "struct", startLine: 1, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
        {
          name: "Speak",
          kind: "method",
          startLine: 5,
          endLine: 7,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Dog",
          isPointerReceiver: false,
        },
        {
          name: "Name",
          kind: "method",
          startLine: 9,
          endLine: 11,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Dog",
          isPointerReceiver: false,
        },
      ],
    };

    fileGraphs.set("animal.go", animalFile);
    fileGraphs.set("dog.go", dogFile);

    const symbolIndex = buildIndex([
      { id: 1, filePath: "animal.go", name: "Animal", kind: "interface", startLine: 1 },
      { id: 2, filePath: "animal.go", name: "Speak", kind: "method", startLine: 2 },
      { id: 3, filePath: "animal.go", name: "Name", kind: "method", startLine: 3 },
      { id: 4, filePath: "dog.go", name: "Dog", kind: "struct", startLine: 1 },
      { id: 5, filePath: "dog.go", name: "Speak", kind: "method", startLine: 5 },
      { id: 6, filePath: "dog.go", name: "Name", kind: "method", startLine: 9 },
    ]);

    const importMaps = new Map();

    const { typeMethodSets, interfaces, embeddingMap } = buildGoTypeIndex(fileGraphs, symbolIndex, importMaps);

    const dogKey = "dog.go::Dog";
    const satisfied = findSatisfiedInterfaces(dogKey, typeMethodSets, embeddingMap, interfaces);

    expect(satisfied).toHaveLength(1);
    expect(satisfied[0].name).toBe("Animal");
    expect(satisfied[0].receiverKind).toBe("value");
  });

  it("pointer-receiver type: only *T satisfies (receiverKind = 'pointer')", () => {
    // Struct Cat with one pointer receiver method: SetName(*Cat)
    // Interface Mutable requires: SetName()
    // Only *Cat satisfies Mutable; Cat (value) does NOT
    const fileGraphs = new Map<string, FileGraphResult>();

    const mutableFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        {
          name: "Mutable",
          kind: "interface",
          startLine: 1,
          endLine: 4,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
        },
        { name: "SetName", kind: "method", startLine: 2, endLine: 2, bodyTokens: "", bodyHash: "", isExported: true },
      ],
    };

    const catFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Cat", kind: "struct", startLine: 1, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
        {
          name: "SetName",
          kind: "method",
          startLine: 5,
          endLine: 7,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Cat",
          isPointerReceiver: true,
        },
      ],
    };

    fileGraphs.set("mutable.go", mutableFile);
    fileGraphs.set("cat.go", catFile);

    const symbolIndex = buildIndex([
      { id: 1, filePath: "mutable.go", name: "Mutable", kind: "interface", startLine: 1 },
      { id: 2, filePath: "mutable.go", name: "SetName", kind: "method", startLine: 2 },
      { id: 3, filePath: "cat.go", name: "Cat", kind: "struct", startLine: 1 },
      { id: 4, filePath: "cat.go", name: "SetName", kind: "method", startLine: 5 },
    ]);

    const importMaps = new Map();

    const { typeMethodSets, interfaces, embeddingMap } = buildGoTypeIndex(fileGraphs, symbolIndex, importMaps);

    const catKey = "cat.go::Cat";
    const satisfied = findSatisfiedInterfaces(catKey, typeMethodSets, embeddingMap, interfaces);

    expect(satisfied).toHaveLength(1);
    expect(satisfied[0].name).toBe("Mutable");
    expect(satisfied[0].receiverKind).toBe("pointer");
  });

  it("mixed receivers: value interface satisfied as 'value', pointer interface as 'pointer'", () => {
    // Struct Server with:
    //   - Start() value receiver
    //   - Stop()  value receiver
    //   - Reset() pointer receiver
    //
    // Interface Lifecycle: Start(), Stop()         → satisfied by T (value)
    // Interface Resettable: Start(), Stop(), Reset() → satisfied by *T only (pointer)
    const fileGraphs = new Map<string, FileGraphResult>();

    const ifaceFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        {
          name: "Lifecycle",
          kind: "interface",
          startLine: 1,
          endLine: 4,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
        },
        { name: "Start", kind: "method", startLine: 2, endLine: 2, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "Stop", kind: "method", startLine: 3, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
        {
          name: "Resettable",
          kind: "interface",
          startLine: 6,
          endLine: 10,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
        },
        { name: "Start", kind: "method", startLine: 7, endLine: 7, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "Stop", kind: "method", startLine: 8, endLine: 8, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "Reset", kind: "method", startLine: 9, endLine: 9, bodyTokens: "", bodyHash: "", isExported: true },
      ],
    };

    const serverFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Server", kind: "struct", startLine: 1, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
        {
          name: "Start",
          kind: "method",
          startLine: 5,
          endLine: 7,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Server",
          isPointerReceiver: false,
        },
        {
          name: "Stop",
          kind: "method",
          startLine: 9,
          endLine: 11,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Server",
          isPointerReceiver: false,
        },
        {
          name: "Reset",
          kind: "method",
          startLine: 13,
          endLine: 15,
          bodyTokens: "",
          bodyHash: "",
          isExported: true,
          receiverType: "Server",
          isPointerReceiver: true,
        },
      ],
    };

    fileGraphs.set("iface.go", ifaceFile);
    fileGraphs.set("server.go", serverFile);

    const symbolIndex = buildIndex([
      { id: 1, filePath: "iface.go", name: "Lifecycle", kind: "interface", startLine: 1 },
      { id: 2, filePath: "iface.go", name: "Start", kind: "method", startLine: 2 },
      { id: 3, filePath: "iface.go", name: "Stop", kind: "method", startLine: 3 },
      { id: 4, filePath: "iface.go", name: "Resettable", kind: "interface", startLine: 6 },
      { id: 5, filePath: "iface.go", name: "Start", kind: "method", startLine: 7 },
      { id: 6, filePath: "iface.go", name: "Stop", kind: "method", startLine: 8 },
      { id: 7, filePath: "iface.go", name: "Reset", kind: "method", startLine: 9 },
      { id: 8, filePath: "server.go", name: "Server", kind: "struct", startLine: 1 },
      { id: 9, filePath: "server.go", name: "Start", kind: "method", startLine: 5 },
      { id: 10, filePath: "server.go", name: "Stop", kind: "method", startLine: 9 },
      { id: 11, filePath: "server.go", name: "Reset", kind: "method", startLine: 13 },
    ]);

    const importMaps = new Map();

    const { typeMethodSets, interfaces, embeddingMap } = buildGoTypeIndex(fileGraphs, symbolIndex, importMaps);

    const serverKey = "server.go::Server";
    const satisfied = findSatisfiedInterfaces(serverKey, typeMethodSets, embeddingMap, interfaces);

    expect(satisfied).toHaveLength(2);

    const lifecycle = satisfied.find((s) => s.name === "Lifecycle");
    const resettable = satisfied.find((s) => s.name === "Resettable");

    expect(lifecycle).toBeDefined();
    expect(lifecycle!.receiverKind).toBe("value");

    expect(resettable).toBeDefined();
    expect(resettable!.receiverKind).toBe("pointer");
  });

  it("no pointer receivers: interface requiring method not on type is not satisfied", () => {
    // Struct Empty with no methods should not satisfy any interface
    const fileGraphs = new Map<string, FileGraphResult>();

    const ifaceFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Worker", kind: "interface", startLine: 1, endLine: 4, bodyTokens: "", bodyHash: "", isExported: true },
        { name: "DoWork", kind: "method", startLine: 2, endLine: 2, bodyTokens: "", bodyHash: "", isExported: true },
      ],
    };

    const emptyStructFile: FileGraphResult = {
      ...emptyResult(),
      symbols: [
        { name: "Empty", kind: "struct", startLine: 1, endLine: 3, bodyTokens: "", bodyHash: "", isExported: true },
      ],
    };

    fileGraphs.set("worker.go", ifaceFile);
    fileGraphs.set("empty.go", emptyStructFile);

    const symbolIndex = buildIndex([
      { id: 1, filePath: "worker.go", name: "Worker", kind: "interface", startLine: 1 },
      { id: 2, filePath: "worker.go", name: "DoWork", kind: "method", startLine: 2 },
      { id: 3, filePath: "empty.go", name: "Empty", kind: "struct", startLine: 1 },
    ]);

    const importMaps = new Map();

    const { typeMethodSets, interfaces, embeddingMap } = buildGoTypeIndex(fileGraphs, symbolIndex, importMaps);

    // Empty has no methods registered, so typeMethodSets won't have it
    // findSatisfiedInterfaces returns [] for unknown types
    const emptyKey = "empty.go::Empty";
    const satisfied = findSatisfiedInterfaces(emptyKey, typeMethodSets, embeddingMap, interfaces);

    expect(satisfied).toHaveLength(0);
  });
});
