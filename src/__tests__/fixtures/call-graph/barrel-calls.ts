import { doThing } from "./barrel.js";

// doThing is re-exported by barrel.ts from helper.ts.
// Known limitation: calleeFile resolves to "barrel.ts", not "helper.ts".
export function callThroughBarrel(): void {
  doThing();
}
