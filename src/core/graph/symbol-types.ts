/**
 * Phase 2 type definitions and constants for the symbol graph.
 * Covers symbol definitions, call sites, heritage chains, edge kinds and weights.
 */

import type { RawImport } from "../types/parser.js";

// ── Symbol kinds ──────────────────────────────────────────────────────────────

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "variable" | "component";

// ── Symbol definition (extracted per file) ────────────────────────────────────

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number | undefined;
  bodyTokens: string;
  bodyHash: string;
  isExported: boolean;
}

// ── Call site (raw, pre-resolution) ───────────────────────────────────────────

export interface RawCallSite {
  callerFn: string | undefined;
  calleeName: string;
  line: number;
  isMemberExpression: boolean;
  objectName: string | undefined;
  isConstructor: boolean;
}

// ── Heritage (extends / implements) ───────────────────────────────────────────

export interface HeritageEdge {
  className: string;
  kind: "extends" | "implements";
  target: string;
  line: number;
}

// ── Decorator ─────────────────────────────────────────────────────────────────

export interface DecoratorEdge {
  target: string;
  decorator: string;
  line: number;
}

// ── Type usage (function param / return type referencing an import) ────────────

export interface TypeUsageEdge {
  symbolName: string;
  typeName: string;
  line: number;
}

// ── Unified single-pass extraction result ─────────────────────────────────────

export interface FileGraphResult {
  imports: RawImport[];
  symbols: SymbolDefinition[];
  callSites: RawCallSite[];
  heritageChains: HeritageEdge[];
  decorators: DecoratorEdge[];
  typeUsages: TypeUsageEdge[];
}

// ── Symbol edge kinds and weights (RFC §6.3) ─────────────────────────────────

export type SymbolEdgeKind = "calls" | "imports" | "extends" | "implements" | "uses_type" | "decorates";

export const SYMBOL_EDGE_WEIGHTS: Record<SymbolEdgeKind, number> = {
  calls: 1.0,
  extends: 1.0,
  implements: 0.3,
  uses_type: 0.3,
  decorates: 0.7,
  imports: 1.0,
};

// ── Resolution confidence per tier ────────────────────────────────────────────

export const RESOLUTION_CONFIDENCE = {
  /** Tier 1: exact name match in import map */
  TIER_1_DIRECT: 0.95,
  /** Tier 2: member expression on known import binding */
  TIER_2_MEMBER: 0.9,
  /** Tier 3: constructor binding + method lookup */
  TIER_3_CONSTRUCTOR: 0.85,
  /** Tier 4: re-export chain (barrel routing) */
  TIER_4_REEXPORT: 0.8,
} as const;

// ── Resolved symbol edge (output of resolution) ──────────────────────────────

export interface ResolvedSymbolEdge {
  fromFile: string;
  fromSymbol: string;
  toFile: string;
  toSymbol: string;
  kind: SymbolEdgeKind;
  line: number;
  confidence: number;
}

// ── Constructor binding (Tier 3 scope-local tracking) ─────────────────────────

export interface ConstructorBinding {
  variableName: string;
  sourceFile: string;
  className: string;
}
