/**
 * Phase 2 type definitions and constants for the symbol graph.
 * Covers symbol definitions, call sites, heritage chains, edge kinds and weights.
 */

import type { RawImport } from "../types/parser";

// ── Symbol kinds ──────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "component"
  | "struct"
  | "enum"
  | "trait";

// ── Symbol definition (extracted per file) ────────────────────────────────────

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number | undefined;
  bodyTokens: string;
  bodyHash: string;
  isExported: boolean;
  /** Go: the struct type this method is defined on (base name, pointer stripped) */
  receiverType?: string;
  /** Go: true if receiver is a pointer (*T), false for value (T) */
  isPointerReceiver?: boolean;
  /** Python: base classes in declaration order (for C3 linearization) */
  bases?: string[];
  /** [Hejlsberg] Python: metaclass name, separated from standard bases to prevent C3 false-positives (RFC §2.12) */
  metaclass?: string;
  /** Java: true for interface default methods */
  isDefault?: boolean;
}

// ── Call site (raw, pre-resolution) ───────────────────────────────────────────

export interface RawCallSite {
  callerFn: string | undefined;
  calleeName: string;
  line: number;
  isMemberExpression: boolean;
  objectName: string | undefined;
  isConstructor: boolean;
  /** Python: true for super().method() calls */
  isSuperCall?: boolean;
}

// ── Heritage (extends / implements) ───────────────────────────────────────────

export interface HeritageEdge {
  className: string;
  kind: "extends" | "implements";
  target: string;
  line: number;
  /** Python: position in base class list (0-indexed) for C3 linearization */
  ordinal?: number;
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

// ── Go struct embedding (RFC §2.13) ───────────────────────────────────────────

export interface EmbeddingEdge {
  structName: string;
  embeddedType: string;
  line: number;
}

// ── Rust impl blocks (RFC §2.14) ──────────────────────────────────────────────

export interface ImplBlock {
  targetType: string;
  traitName: string | undefined;
  methods: string[];
  derefTarget: string | undefined;
  filePath: string;
}

// ── Type aliases (RFC §2.15) ──────────────────────────────────────────────────

export interface TypeAlias {
  name: string;
  target: string;
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
  /** Variable-to-constructor assignments for Tier 3 resolution (RFC §2.6) */
  constructorAssignments: ConstructorAssignment[];
  /** Go: struct embedded fields for method promotion (RFC §2.13) */
  embeddings: EmbeddingEdge[];
  /** Rust: impl blocks for method indexing (RFC §2.14) */
  implBlocks: ImplBlock[];
  /** All languages: type aliases for transparent resolution (RFC §2.15) */
  typeAliases: TypeAlias[];
  /** Language-semantic edges: implicit interfaces, deref chains, DI injection (audit Shift 3) */
  semanticEdges: SemanticEdge[];
}

// ── Symbol edge kinds and weights (RFC §6.3) ─────────────────────────────────

export type SymbolEdgeKind =
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "satisfies"
  | "embeds"
  | "uses_type"
  | "decorates";

export const SYMBOL_EDGE_WEIGHTS: Record<SymbolEdgeKind, number> = {
  calls: 1.0,
  extends: 1.0,
  implements: 0.3,
  satisfies: 0.3,
  embeds: 0.8,
  uses_type: 0.3,
  decorates: 0.7,
  imports: 1.0,
};

// ── Ghost edge types (RFC-002 Phase 5) ────────────────────────────────────

export type GhostEdgeKind =
  | "ghost:di_inject"
  | "ghost:event_bind"
  | "ghost:route"
  | "ghost:trait_bound"
  | "ghost:descriptor";

export type ExtendedEdgeKind = SymbolEdgeKind | GhostEdgeKind;

/** Maps ghost suffix to its base SymbolEdgeKind for transmission lookup */
export const GHOST_BASE_KIND: Record<string, SymbolEdgeKind> = {
  di_inject: "calls",
  event_bind: "calls",
  route: "calls",
  trait_bound: "implements",
  descriptor: "uses_type",
};

/**
 * Look up edge weight by kind string.
 * Checks SYMBOL_EDGE_WEIGHTS first, then GHOST_BASE_KIND for ghost: prefix,
 * falls back to 0.3 (uses_type level, per RFC spec).
 */
export function getEdgeWeight(kind: string): number {
  const direct = SYMBOL_EDGE_WEIGHTS[kind as SymbolEdgeKind];
  if (direct !== undefined) return direct;

  if (kind.startsWith("ghost:")) {
    const base = GHOST_BASE_KIND[kind.slice(6)];
    if (base) return SYMBOL_EDGE_WEIGHTS[base];
  }

  return 0.3;
}

/** Evidence attached to a ghost edge candidate */
export interface GhostEdgeEvidence {
  pattern: string;
  trigger?: string;
  eventName?: string;
  routePath?: string;
}

// ── Resolution confidence per tier (pattern-aware, audit F2) ─────────────────

export const RESOLUTION_CONFIDENCE = {
  /** Tier 1: exact name match in import map */
  TIER_1_DIRECT: 0.95,
  /** Tier 2: member expression on known import binding */
  TIER_2_MEMBER: 0.9,
  /** Tier 3: explicit `new Constructor()` (or language equivalent) */
  TIER_3_NEW: 0.95,
  /** Tier 3: factory call or DI container resolution (unknown return type) */
  TIER_3_FACTORY: 0.25,
  /** Per-hop multiplier for barrel re-export chains (0.90^hops) */
  BARREL_HOP_DECAY: 0.9,
} as const;

/**
 * Compute confidence for a barrel-routed edge.
 * Each barrel hop multiplies confidence by BARREL_HOP_DECAY.
 * @param baseConfidence - the tier confidence before barrel adjustment
 * @param hops - number of barrel files traversed (default 1)
 */
export function barrelAdjustedConfidence(baseConfidence: number, hops = 1): number {
  return baseConfidence * RESOLUTION_CONFIDENCE.BARREL_HOP_DECAY ** hops;
}

// ── Resolved symbol edge (output of resolution) ──────────────────────────────

export interface ResolvedSymbolEdge {
  fromFile: string;
  fromSymbol: string;
  toFile: string;
  toSymbol: string;
  kind: ExtendedEdgeKind;
  line: number;
  confidence: number;
  /** Python MRO: base class position in declaration order (0-indexed) */
  ordinal?: number;
}

// ── Constructor assignment (Tier 3 extraction) ────────────────────────────────

/**
 * A variable assigned from a `new` expression, extracted from the AST.
 * e.g. `const svc = new UserService()` → variableName: "svc", className: "UserService"
 */
export interface ConstructorAssignment {
  /** Variable that holds the instance (e.g. "svc") */
  variableName: string;
  /** Class being constructed (e.g. "UserService") */
  className: string;
  /** Enclosing function — scope boundary for Tier 3 (RFC §2.6) */
  callerFn: string | undefined;
  line: number;
  /**
   * Construction pattern (audit F2):
   * - "new": explicit `new Constructor()` (TS/JS), struct literal (Go), capitalized call (Python)
   * - "call": factory function or DI container resolution (unknown return type)
   * Defaults to "new" for backward compatibility with existing extractors.
   */
  pattern?: "new" | "call";
}

// ── Constructor binding (Tier 3 scope-local tracking) ─────────────────────────

export interface ConstructorBinding {
  variableName: string;
  sourceFile: string;
  className: string;
  /** Construction pattern for confidence computation (audit F2) */
  pattern?: "new" | "call";
}

// ── Language-semantic edge types (audit Shift 3) ──────────────────────────────

/** Language-specific semantic relationships beyond structural imports */
export type SemanticEdgeKind =
  | "go:implicit_iface"
  | "go:implicit_iface_pointer_only"
  | "rust:deref_coercion"
  | "python:factory_binding"
  | "java:annotation_injection";

export interface SemanticEdge {
  fromFile: string;
  fromSymbol: string;
  toFile: string;
  toSymbol: string;
  kind: SemanticEdgeKind;
  line: number;
  confidence: number;
  /** Human-readable explanation of the semantic relationship */
  reason: string;
}
