import type { PersistedGraph } from "../types/persisted-graph.js";
import type { IdealFile } from "../types/learn.js";
import { LEARN } from "../config/thresholds.js";

export const ROLE_PRIORITY: IdealFile["role"][] = [
  "dependency",
  "dependent",
  "hidden-dep",
  "co-change",
  "test",
  "edited",
];

export interface ContextSetOptions {
  maxDependentsPerFile?: number;
  coChangeThreshold?: number;
  mismatchThreshold?: number;
}

function shouldReplace(existing: IdealFile["role"], candidate: IdealFile["role"]): boolean {
  return ROLE_PRIORITY.indexOf(candidate) > ROLE_PRIORITY.indexOf(existing);
}

function setIdealFile(idealSet: Map<string, IdealFile>, file: string, role: IdealFile["role"], source: string): void {
  const existing = idealSet.get(file);
  if (!existing || shouldReplace(existing.role, role)) {
    idealSet.set(file, { role, source });
  }
}

export function buildIdealContextSet(
  editedFiles: string[],
  graph: PersistedGraph,
  options?: ContextSetOptions,
): Map<string, IdealFile> {
  const maxDependents = options?.maxDependentsPerFile ?? LEARN.MAX_DEPENDENTS;
  const coChangeThreshold = options?.coChangeThreshold ?? LEARN.COCHANGE_THRESHOLD;
  const mismatchThreshold = options?.mismatchThreshold ?? LEARN.MISMATCH_THRESHOLD;

  const idealSet = new Map<string, IdealFile>();

  // Build reverse edge index once: target -> [{from, importedNames}]
  const reverseEdges = new Map<string, Array<{ from: string; importedNames: string[] }>>();
  for (const edge of graph.edges) {
    let list = reverseEdges.get(edge.to);
    if (!list) {
      list = [];
      reverseEdges.set(edge.to, list);
    }
    list.push({ from: edge.from, importedNames: edge.importedNames });
  }

  // Build forward edge index: source -> [target]
  const forwardEdges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    let list = forwardEdges.get(edge.from);
    if (!list) {
      list = [];
      forwardEdges.set(edge.from, list);
    }
    list.push(edge.to);
  }

  for (const edited of editedFiles) {
    // L0: edited file itself
    setIdealFile(idealSet, edited, "edited", edited);

    // Skip L1-L5 if file not in graph
    if (!graph.files[edited]) continue;

    // L1: direct importers (reverse edges), capped at maxDependents
    const importers = reverseEdges.get(edited) ?? [];
    const sorted = importers
      .filter((imp) => graph.files[imp.from])
      .sort((a, b) => {
        const countA = graph.files[a.from]?.importedByCount ?? 0;
        const countB = graph.files[b.from]?.importedByCount ?? 0;
        return countB - countA;
      });
    for (const imp of sorted.slice(0, maxDependents)) {
      setIdealFile(idealSet, imp.from, "dependent", edited);
    }

    // L2: direct imports (forward edges)
    const imports = forwardEdges.get(edited) ?? [];
    for (const dep of imports) {
      setIdealFile(idealSet, dep, "dependency", edited);
    }

    // L3: test files
    const tests = graph.testMapping[edited] ?? [];
    for (const test of tests) {
      setIdealFile(idealSet, test, "test", edited);
    }
  }

  // L4: co-change partners (check both directions)
  const editedSet = new Set(editedFiles);
  for (const coupling of graph.changeCoupling) {
    if (coupling.confidence < coChangeThreshold) continue;
    if (editedSet.has(coupling.fileA) && !editedSet.has(coupling.fileB)) {
      setIdealFile(idealSet, coupling.fileB, "co-change", coupling.fileA);
    }
    if (editedSet.has(coupling.fileB) && !editedSet.has(coupling.fileA)) {
      setIdealFile(idealSet, coupling.fileA, "co-change", coupling.fileB);
    }
  }

  // L5: structural mismatch partners
  for (const mismatch of graph.structuralMismatches) {
    if (mismatch.coChangeConfidence < mismatchThreshold) continue;
    if (editedSet.has(mismatch.fileA) && !editedSet.has(mismatch.fileB)) {
      setIdealFile(idealSet, mismatch.fileB, "hidden-dep", mismatch.fileA);
    }
    if (editedSet.has(mismatch.fileB) && !editedSet.has(mismatch.fileA)) {
      setIdealFile(idealSet, mismatch.fileA, "hidden-dep", mismatch.fileB);
    }
  }

  return idealSet;
}
