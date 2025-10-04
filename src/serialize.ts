import type {
  CodeSnapshot,
  ContextAnalysis,
  DetectedContext,
  ImportGraph,
} from "./types.js";
import { buildDirectives } from "./templates/directives.js";

/** Structured JSON output for clarte --format=json */
export interface ClarteJsonOutput {
  version: number;
  project: {
    name: string;
    rootDir: string;
    language: string;
    hasTypeScript: boolean;
    packageManager: string;
    linter: string;
    frameworks: Array<{ name: string; version?: string; importCount?: number }>;
    directories: string[];
    testFramework?: string;
    ciProvider?: string;
    monorepo: {
      type: string;
      packages: Array<{
        name: string;
        path: string;
        dependencies: string[];
        frameworks: Array<{ name: string; version?: string }>;
      }>;
    } | null;
    sourceFileCount: number;
    totalSourceBytes: number;
  };
  analysis: {
    hubFiles: ContextAnalysis["hubFiles"];
    circularDeps: ContextAnalysis["circularDeps"];
    layers: ContextAnalysis["layers"];
    layerEdges: ContextAnalysis["layerEdges"];
    communities: ContextAnalysis["communities"];
    instabilities: ContextAnalysis["instabilities"];
    deadFiles?: string[];
    crossCuttingFiles?: ContextAnalysis["crossCuttingFiles"];
    chokepoints?: ContextAnalysis["chokepoints"];
    tightCouplings?: ContextAnalysis["tightCouplings"];
    conventions?: ContextAnalysis["conventions"];
    configConstraints?: ContextAnalysis["configConstraints"];
    testMapping?: {
      sourceToTests: Record<string, string[]>;
      untestedFiles: string[];
      testPattern?: { framework: string; convention: string; filePattern: string };
    };
    gitActivity?: {
      commitCounts: Record<string, number>;
      hotFiles: Array<{ path: string; commits: number; lastChanged: string }>;
      changeCoupling: ContextAnalysis["gitActivity"] extends infer G
        ? G extends { changeCoupling: infer C } ? C : never
        : never;
    };
    graphTopology?: ContextAnalysis["graphTopology"];
    structuralMismatches?: ContextAnalysis["structuralMismatches"];
    monorepoAnalysis?: {
      crossPackageEdges: Array<{
        from: string;
        to: string;
        fromPackage: string;
        toPackage: string;
        isEncapsulationViolation: boolean;
      }>;
      encapsulationViolations: Array<{
        from: string;
        to: string;
        fromPackage: string;
        toPackage: string;
        isEncapsulationViolation: boolean;
      }>;
      packageDependencies: Record<string, string[]>;
    };
  };
  snapshot: {
    entries: Array<{ file: string; category: string; signature: string; importedByCount?: number }>;
    estimatedTokens?: number;
    budgetExcluded?: number;
  } | null;
  directives: string[];
}

/** Convert a Map to a plain object for JSON serialization. */
function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  const record: Record<string, V> = {};
  for (const [key, value] of map) {
    record[key] = value;
  }
  return record;
}

/**
 * Serialize all analysis data into a structured JSON output.
 */
export function serializeAnalysis(
  ctx: DetectedContext,
  analysis: ContextAnalysis,
  snapshot: CodeSnapshot | null,
  _graph: ImportGraph,
  directives: string[],
): ClarteJsonOutput {
  return {
    version: 1,
    project: {
      name: ctx.rootDir.split("/").pop() ?? "unknown",
      rootDir: ctx.rootDir,
      language: ctx.language,
      hasTypeScript: ctx.hasTypeScript,
      packageManager: ctx.packageManager,
      linter: ctx.linter,
      frameworks: ctx.frameworks.map((f) => ({
        name: f.name,
        version: f.version,
        importCount: f.importCount,
      })),
      directories: ctx.directories,
      testFramework: ctx.testFramework,
      ciProvider: ctx.ciProvider,
      monorepo: ctx.monorepo
        ? {
            type: ctx.monorepo.type,
            packages: ctx.monorepo.packages.map((p) => ({
              name: p.name,
              path: p.path,
              dependencies: p.dependencies,
              frameworks: p.frameworks.map((f) => ({
                name: f.name,
                version: f.version,
              })),
            })),
          }
        : null,
      sourceFileCount: ctx.sourceFileCount,
      totalSourceBytes: ctx.totalSourceBytes,
    },
    analysis: {
      hubFiles: analysis.hubFiles,
      circularDeps: analysis.circularDeps,
      layers: analysis.layers,
      layerEdges: analysis.layerEdges,
      communities: analysis.communities,
      instabilities: analysis.instabilities,
      deadFiles: analysis.deadFiles,
      crossCuttingFiles: analysis.crossCuttingFiles,
      chokepoints: analysis.chokepoints,
      tightCouplings: analysis.tightCouplings,
      conventions: analysis.conventions,
      configConstraints: analysis.configConstraints,
      testMapping: analysis.testMapping
        ? {
            sourceToTests: mapToRecord(analysis.testMapping.sourceToTests),
            untestedFiles: analysis.testMapping.untestedFiles,
            testPattern: analysis.testMapping.testPattern,
          }
        : undefined,
      gitActivity: analysis.gitActivity
        ? {
            commitCounts: mapToRecord(analysis.gitActivity.commitCounts),
            hotFiles: analysis.gitActivity.hotFiles,
            changeCoupling: analysis.gitActivity.changeCoupling,
          }
        : undefined,
      graphTopology: analysis.graphTopology,
      structuralMismatches: analysis.structuralMismatches,
      monorepoAnalysis: analysis.monorepoAnalysis
        ? {
            crossPackageEdges: analysis.monorepoAnalysis.crossPackageEdges,
            encapsulationViolations: analysis.monorepoAnalysis.encapsulationViolations,
            packageDependencies: mapToRecord(
              new Map(
                [...analysis.monorepoAnalysis.packageDependencies.entries()].map(
                  ([k, v]) => [k, [...v]],
                ),
              ),
            ),
          }
        : undefined,
    },
    snapshot: snapshot
      ? {
          entries: snapshot.entries.map((e) => ({
            file: e.file,
            category: e.category,
            signature: e.signature,
            importedByCount: e.importedByCount,
          })),
          estimatedTokens: snapshot.estimatedTokens,
          budgetExcluded: snapshot.budgetExcluded,
        }
      : null,
    directives,
  };
}
