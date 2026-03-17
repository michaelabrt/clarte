/**
 * Route registration ghost edge detector.
 *
 * Detects two patterns:
 * 1. Decorator routes: @Get/@Post/etc on methods within @Controller classes
 * 2. Method-chain routes: router.get()/post()/use() grouping by router instance
 */

import type { FileGraphResult } from "../graph/symbol-types";
import type { SymbolIndex } from "../graph/symbol-resolution";
import type { ImportBinding } from "../graph/symbol-resolution";
import type { GhostEdgeCandidate } from "../graph/ghost-types";
import { GHOST_CONFIDENCE } from "../graph/ghost-types";

const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Delete", "Patch"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "use"]);

/**
 * Detect route registration edges.
 *
 * Decorator routes: link @Get/@Post methods to their @Controller class.
 * Method-chain routes: link .use() middleware to handler call sites on the same router.
 */
export function detectRouteEdges(
  fileGraphResults: Map<string, FileGraphResult>,
  _symbolIndex: SymbolIndex,
  _importMaps: Map<string, Map<string, ImportBinding>>,
): GhostEdgeCandidate[] {
  const candidates: GhostEdgeCandidate[] = [];

  for (const [filePath, result] of fileGraphResults) {
    // ── Decorator routes: @Get/@Post methods -> @Controller class ──────
    const controllerTargets = new Set<string>();
    const routeTargets = new Set<string>();

    for (const dec of result.decorators) {
      if (dec.decorator === "Controller") {
        controllerTargets.add(dec.target);
      }
      if (ROUTE_DECORATORS.has(dec.decorator)) {
        routeTargets.add(dec.target);
      }
    }

    // Link route-decorated methods to their controller class
    if (controllerTargets.size > 0 && routeTargets.size > 0) {
      // Find which methods belong to which controller by line range
      for (const sym of result.symbols) {
        if (sym.kind !== "class" || !controllerTargets.has(sym.name)) continue;
        const classEnd = sym.endLine ?? Number.MAX_SAFE_INTEGER;

        for (const method of result.symbols) {
          if (method.kind !== "method") continue;
          if (!routeTargets.has(method.name)) continue;
          if (method.startLine < sym.startLine || method.startLine > classEnd) continue;

          candidates.push({
            fromFile: filePath,
            fromSymbol: method.name,
            toFile: filePath,
            toSymbol: sym.name,
            kind: "ghost:route",
            confidence: GHOST_CONFIDENCE,
            line: method.startLine,
            evidence: {
              pattern: "decorator_route",
              trigger: sym.name,
            },
          });
        }
      }
    }

    // ── Method-chain routes: group by router objectName ────────────────
    const routerGroups = new Map<string, Array<{ callerFn: string; method: string; line: number }>>();

    for (const cs of result.callSites) {
      if (!cs.isMemberExpression || !cs.objectName) continue;
      if (!ROUTE_METHODS.has(cs.calleeName)) continue;
      if (!cs.callerFn) continue;

      let group = routerGroups.get(cs.objectName);
      if (!group) {
        group = [];
        routerGroups.set(cs.objectName, group);
      }
      group.push({ callerFn: cs.callerFn, method: cs.calleeName, line: cs.line });
    }

    // Link middleware (.use) to handlers on the same router
    for (const [_routerName, sites] of routerGroups) {
      const middleware = sites.filter((s) => s.method === "use");
      const handlers = sites.filter((s) => s.method !== "use");

      for (const mw of middleware) {
        for (const handler of handlers) {
          if (mw.callerFn === handler.callerFn) continue;

          candidates.push({
            fromFile: filePath,
            fromSymbol: mw.callerFn,
            toFile: filePath,
            toSymbol: handler.callerFn,
            kind: "ghost:route",
            confidence: GHOST_CONFIDENCE,
            line: mw.line,
            evidence: {
              pattern: "method_chain_route",
              routePath: handler.method,
            },
          });
        }
      }
    }
  }

  return candidates;
}
