type ImportGroupKind = "external" | "internal" | "relative" | "node-builtin";

interface ImportLine {
  kind: ImportGroupKind;
  blankBefore: boolean;
  specifier: string;
}

function classifyImportKind(specifier: string): ImportGroupKind {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("node:")) return "node-builtin";
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) return "internal";
  if (!specifier.startsWith(".")) return "external";
  return "relative";
}

function isGroupAlphabetical(specifiers: string[]): boolean {
  if (specifiers.length <= 1) return true;
  for (let i = 1; i < specifiers.length; i++) {
    if (specifiers[i].localeCompare(specifiers[i - 1]) < 0) return false;
  }
  return true;
}

export interface ImportOrderingResult {
  ordering: string | null;
  alphabetical: boolean;
  nodeBuiltinSeparated: boolean;
}

export function detectImportOrderingDetailed(content: string): ImportOrderingResult {
  const lines = content.split("\n");
  const importLines: ImportLine[] = [];
  let lastWasBlank = false;
  let lastWasImport = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      if (lastWasImport) lastWasBlank = true;
      continue;
    }

    const importMatch = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
    const importSideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    const specifier = importMatch?.[1] ?? importSideEffect?.[1];

    if (specifier) {
      importLines.push({
        kind: classifyImportKind(specifier),
        blankBefore: lastWasBlank && lastWasImport,
        specifier,
      });
      lastWasBlank = false;
      lastWasImport = true;
    } else if (lastWasImport && !trimmed.startsWith("import")) {
      break;
    }
  }

  if (importLines.length < 3) {
    return { ordering: null, alphabetical: false, nodeBuiltinSeparated: false };
  }

  const baseKind = (k: ImportGroupKind) => (k === "node-builtin" ? "external" : k);

  const firstExternal = importLines.findIndex((l) => baseKind(l.kind) === "external");
  const firstRelative = importLines.findIndex((l) => l.kind === "relative");

  const externalFirst = firstExternal !== -1 && (firstRelative === -1 || firstExternal < firstRelative);

  const hasBlankSep = importLines.some((l) => l.blankBefore);

  let alphabetical = true;
  let currentGroup: string[] = [importLines[0].specifier];
  let currentKind = baseKind(importLines[0].kind);
  for (let i = 1; i < importLines.length; i++) {
    const kind = baseKind(importLines[i].kind);
    if (kind === currentKind && !importLines[i].blankBefore) {
      currentGroup.push(importLines[i].specifier);
    } else {
      if (!isGroupAlphabetical(currentGroup)) {
        alphabetical = false;
        break;
      }
      currentGroup = [importLines[i].specifier];
      currentKind = kind;
    }
  }
  if (alphabetical && !isGroupAlphabetical(currentGroup)) {
    alphabetical = false;
  }

  const hasNodeBuiltin = importLines.some((l) => l.kind === "node-builtin");
  const hasOtherExternal = importLines.some((l) => baseKind(l.kind) === "external" && l.kind !== "node-builtin");
  let nodeBuiltinSeparated = false;
  if (hasNodeBuiltin && hasOtherExternal) {
    for (let i = 1; i < importLines.length; i++) {
      const prev = importLines[i - 1].kind;
      const curr = importLines[i].kind;
      if (
        (prev === "node-builtin" && baseKind(curr) === "external" && curr !== "node-builtin") ||
        (baseKind(prev) === "external" && prev !== "node-builtin" && curr === "node-builtin")
      ) {
        if (importLines[i].blankBefore) {
          nodeBuiltinSeparated = true;
        }
        break;
      }
    }
  }

  let ordering: string | null = null;
  if (externalFirst && hasBlankSep) {
    ordering = "external-first, blank-line separated";
  } else if (externalFirst) {
    ordering = "external-first";
  }

  return { ordering, alphabetical, nodeBuiltinSeparated };
}
