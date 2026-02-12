import { doThing } from "./helper.js";

export function withChain(): void {
  // Direct call - should resolve to helper.ts
  doThing();

  // Chained call a.b().c() - callee name is "c", not imported, so unresolved and excluded
  const obj = { b: () => ({ c: () => {} }) };
  obj.b().c();
}
