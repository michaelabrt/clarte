import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";
import { extractNodeBlock, extractSignatureBeforeBody, stripAnnotationName } from "../core/parsers/snapshot-utils";

// Minimal Node stub - only the properties snapshot-utils.ts actually reads
function makeNode(overrides: {
  startIndex: number;
  endIndex: number;
  text?: string;
  bodyStartIndex?: number | null;
}): Node {
  const body = overrides.bodyStartIndex != null ? ({ startIndex: overrides.bodyStartIndex } as unknown as Node) : null;
  return {
    startIndex: overrides.startIndex,
    endIndex: overrides.endIndex,
    text: overrides.text ?? "",
    childForFieldName: (field: string) => (field === "body" ? body : null),
  } as unknown as Node;
}

// ---------------------------------------------------------------------------
// stripAnnotationName
// ---------------------------------------------------------------------------

describe("stripAnnotationName", () => {
  it("strips leading @ and returns the bare name", () => {
    expect(stripAnnotationName("@Column")).toBe("Column");
  });

  it("strips @ and drops parenthesised arguments", () => {
    expect(stripAnnotationName('@Column(name = "id")')).toBe("Column");
  });

  it("handles annotation with empty arg list", () => {
    expect(stripAnnotationName("@Override()")).toBe("Override");
  });

  it("leaves text unchanged when there is no @ prefix", () => {
    expect(stripAnnotationName("Column")).toBe("Column");
  });

  it("handles text that has only @", () => {
    expect(stripAnnotationName("@")).toBe("");
  });

  it("handles annotation name with no args containing a space", () => {
    // only the first segment before '(' matters
    expect(stripAnnotationName("@ManyToOne")).toBe("ManyToOne");
  });
});

// ---------------------------------------------------------------------------
// extractSignatureBeforeBody - with body node present
// ---------------------------------------------------------------------------

describe("extractSignatureBeforeBody - body node found", () => {
  it("slices content from node start to body start", () => {
    //  content: "func Foo() { return 1 }"
    //  node covers entire string; body '{' starts at index 11
    const content = "func Foo() { return 1 }";
    const node = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: 11 });

    expect(extractSignatureBeforeBody(node, content)).toBe("func Foo()");
  });

  it("trims surrounding whitespace from the extracted signature", () => {
    const content = "  func Bar()   { body }";
    // node starts at 2 (after leading spaces), body at 15
    const node = makeNode({ startIndex: 2, endIndex: content.length, bodyStartIndex: 15 });

    const result = extractSignatureBeforeBody(node, content);
    expect(result).toBe("func Bar()");
  });

  it("uses startNode.startIndex when startNode is provided", () => {
    // Simulates extracting only a name+params portion from inside a larger node
    const content = "public static void doThing(int x) { }";
    // outer node starts at 0; startNode starts at 7 ("static void doThing(int x) ")
    const outerNode = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: 34 });
    const startNode = makeNode({ startIndex: 7, endIndex: content.length });

    const result = extractSignatureBeforeBody(outerNode, content, startNode);
    expect(result).toBe("static void doThing(int x)");
  });

  it("returns empty string when signature part is only whitespace", () => {
    const content = " { }";
    const node = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: 1 });

    expect(extractSignatureBeforeBody(node, content)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractSignatureBeforeBody - fallback (no body node)
// ---------------------------------------------------------------------------

describe("extractSignatureBeforeBody - no body node (brace fallback)", () => {
  it("falls back to splitting on the first '{' when there is no body node", () => {
    const content = "fn compute(x: i32) -> i32 { x * 2 }";
    const node = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: null });

    expect(extractSignatureBeforeBody(node, content)).toBe("fn compute(x: i32) -> i32");
  });

  it("returns the full text when there is no '{' and no body node", () => {
    const content = "fn stub(x: i32) -> i32;";
    const node = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: null });

    expect(extractSignatureBeforeBody(node, content)).toBe("fn stub(x: i32) -> i32;");
  });

  it("trims result when falling back to brace split", () => {
    const content = "  func WithSpaces()  { body }";
    const node = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: null });

    expect(extractSignatureBeforeBody(node, content)).toBe("func WithSpaces()");
  });

  it("uses startNode offset when falling back via brace split", () => {
    const content = "ignored   relevant() { body }";
    // startNode begins at offset 10 (the 'r' of 'relevant')
    const outerNode = makeNode({ startIndex: 0, endIndex: content.length, bodyStartIndex: null });
    const startNode = makeNode({ startIndex: 10, endIndex: content.length });

    expect(extractSignatureBeforeBody(outerNode, content, startNode)).toBe("relevant()");
  });
});

// ---------------------------------------------------------------------------
// extractNodeBlock
// ---------------------------------------------------------------------------

describe("extractNodeBlock", () => {
  it("trims per-line indentation and joins lines", () => {
    const nodeWithText = {
      text: "  struct Foo {\n    field: i32\n  }",
      startIndex: 0,
      endIndex: 30,
      childForFieldName: () => null,
    } as unknown as Node;

    const result = extractNodeBlock(nodeWithText);
    expect(result).toBe("struct Foo {\nfield: i32\n}");
  });

  it("caps output at 30 lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `  line${i}`);
    const nodeWithText = {
      text: lines.join("\n"),
      startIndex: 0,
      endIndex: 100,
      childForFieldName: () => null,
    } as unknown as Node;

    const result = extractNodeBlock(nodeWithText);
    const resultLines = result.split("\n");
    expect(resultLines.length).toBe(30);
    expect(resultLines[0]).toBe("line0");
    expect(resultLines[29]).toBe("line29");
  });

  it("does not truncate when exactly 30 lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const nodeWithText = {
      text: lines.join("\n"),
      startIndex: 0,
      endIndex: 100,
      childForFieldName: () => null,
    } as unknown as Node;

    const result = extractNodeBlock(nodeWithText);
    expect(result.split("\n").length).toBe(30);
  });

  it("returns trimmed single-line text", () => {
    const nodeWithText = {
      text: "   type Foo = string;   ",
      startIndex: 0,
      endIndex: 24,
      childForFieldName: () => null,
    } as unknown as Node;

    expect(extractNodeBlock(nodeWithText)).toBe("type Foo = string;");
  });
});
