/** A file imported across multiple architectural layers */
export interface CrossCuttingFile {
  /** Relative file path */
  file: string;
  /** Total number of files that import this file */
  totalImporters: number;
  /** Number of distinct architectural layers importing this file */
  layerSpread: number;
  /** Which layers import this file */
  layers: string[];
}

/** A layer dependency violation (import flowing upward) */
export interface LayerViolation {
  /** File that contains the import */
  from: string;
  /** File being imported */
  to: string;
  /** Layer of the importing file */
  fromLayer: string;
  /** Layer of the imported file */
  toLayer: string;
}

/** Layer dependency consistency result */
export interface LayerConsistency {
  /** Fraction of cross-layer imports that follow the expected direction (0-1) */
  consistency: number;
  /** Import edges that violate the expected layer ordering */
  violations: LayerViolation[];
}

/** An articulation point (chokepoint) in the import graph */
export interface Chokepoint {
  /** Relative file path */
  file: string;
  /** Number of disconnected components if this file were removed */
  separates: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Files that would be disconnected from the main component if this file were removed */
  dependents?: string[];
}

/** Inferred coding conventions from source analysis */
export interface InferredConventions {
  naming: {
    functions: string;
    types: string;
    constants: string;
    files: string;
  };
  exportStyle: {
    preferNamed: boolean;
    defaultExportPercent: number;
    barrelFileCount: number;
  };
  importOrdering?: string;
  /** Per-directory convention overrides when a directory differs from global conventions */
  directoryOverrides?: Array<{
    directory: string;
    naming: { functions?: string; types?: string; constants?: string; files?: string };
  }>;
  /** Detected function name prefix patterns (e.g., use*, is*, get*) */
  namingPrefixes?: Array<{ prefix: string; count: number; example: string }>;
}

/** File pair that co-changes frequently but is structurally distant */
export interface StructuralTemporalMismatch {
  fileA: string;
  fileB: string;
  /** BFS shortest path distance in the import graph (-1 if unreachable) */
  graphDistance: number;
  /** Co-change confidence from git analysis */
  coChangeConfidence: number;
  /** Number of co-changes */
  coChangeCount: number;
}

/** File pair with high import specificity (many named imports) */
export interface TightCoupling {
  /** The file doing the importing */
  from: string;
  /** The file being imported from */
  to: string;
  /** Number of named imports */
  importedNames: number;
  /** The actual imported names */
  names: string[];
}

/** Graph topology metrics (connected components, diameter, reachability) */
export interface GraphTopology {
  /** Number of connected components */
  componentCount: number;
  /** Sizes of each connected component, sorted descending */
  componentSizes: number[];
  /** Approximate graph diameter (longest shortest path sampled) */
  approximateDiameter: number;
  /** Fraction of files reachable from the largest component */
  reachability: number;
  /** Whether the codebase has independent subsystems (>1 component with 5+ files) */
  isFragmented: boolean;
}

/** Classification of test file type */
export type TestType = "unit" | "integration" | "e2e";

/** Test-to-source file mapping */
export interface TestMapping {
  sourceToTests: Map<string, string[]>;
  untestedFiles: string[];
  testPattern?: {
    framework: string;
    convention: string;
    filePattern: string;
  };
  /** Classification of each test file by type (unit, integration, e2e) */
  testTypes?: Map<string, TestType>;
  /** Most comprehensive test file (imports the most source modules), useful as pattern reference */
  exemplarTestFile?: string;
}

/** A cross-package import edge in a monorepo */
export interface CrossPackageEdge {
  /** Source file (relative path) */
  from: string;
  /** Target file (relative path) */
  to: string;
  /** Source package name */
  fromPackage: string;
  /** Target package name */
  toPackage: string;
  /** Whether this import accesses internal files (not the package's public API) */
  isEncapsulationViolation: boolean;
}

/** Top hub file within a package, derived from per-package HITS */
export interface PackageHubFile {
  /** Relative file path */
  path: string;
  /** HITS authority score within the package subgraph */
  authority: number;
}

/** Monorepo-specific analysis results */
export interface MonorepoAnalysis {
  /** Import edges crossing package boundaries */
  crossPackageEdges: CrossPackageEdge[];
  /** Encapsulation violations (imports of internal files) */
  encapsulationViolations: CrossPackageEdge[];
  /** Dependencies between packages (package name -> set of dependent package names) */
  packageDependencies: Map<string, Set<string>>;
  /** Top hub files per package (package name -> top files by authority) */
  packageHubFiles?: Map<string, PackageHubFile[]>;
}

/** An architectural fitness violation */
export interface ArchViolation {
  /** File that violates the rule */
  from: string;
  /** File being imported in violation */
  to: string;
  /** Rule identifier (e.g. "no-upward-dep", "test-isolation", "layer-skip") */
  rule: string;
  /** Human-readable message describing the violation */
  message: string;
  /** Severity level */
  severity: "error" | "warning";
}
