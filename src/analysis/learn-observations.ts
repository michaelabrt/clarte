import type { PersistedGraph } from "../types/persisted-graph.js";
import type { IdealFile, Observation, ParsedSession, ToolEvent } from "../types/learn.js";
import type { ContextSetOptions } from "./learn-context.js";
import { LEARN } from "../config/thresholds.js";

// Test runner commands we recognize in Bash events
const TEST_COMMANDS = new Set(["vitest", "jest", "pytest"]);
// File-reading shell commands
const FILE_READ_COMMANDS = new Set(["cat", "head", "tail"]);

function extractModifiedFiles(events: ToolEvent[]): Map<string, "Edit" | "Write"> {
  const modified = new Map<string, "Edit" | "Write">();
  for (const event of events) {
    if (event.tool !== "Edit" && event.tool !== "Write") continue;
    const file = event.relativePath;
    if (!file) continue;
    // Edit overrides Write (more interesting signal)
    if (event.tool === "Edit" || !modified.has(file)) {
      modified.set(file, event.tool);
    }
  }
  return modified;
}

export function extractReadFiles(events: ToolEvent[]): Set<string> {
  const read = new Set<string>();
  for (const event of events) {
    if (event.tool === "Read" && event.relativePath) {
      read.add(event.relativePath);
    }
    if (event.tool === "Bash" && event.command) {
      for (const file of extractBashFilePaths(event.command, FILE_READ_COMMANDS)) {
        read.add(file);
      }
    }
  }
  return read;
}

function wasFileInSearchResults(file: string, events: ToolEvent[], beforeIndex: number): boolean {
  for (let i = 0; i < beforeIndex; i++) {
    const event = events[i];
    if ((event.tool === "Grep" || event.tool === "Glob") && event.resultFiles) {
      if (event.resultFiles.includes(file)) return true;
    }
  }
  return false;
}

function extractBashFilePaths(command: string, commandSet: Set<string>): string[] {
  const tokens = command.split(/\s+/);
  const files: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // Strip env-var-like prefixes (e.g., FORCE_COLOR=0)
    const token = tokens[i].replace(/^[A-Z_]+=\S*$/, "");
    if (!token) continue;

    const basename = token.split("/").pop() ?? token;
    if (commandSet.has(basename) || commandSet.has(token)) {
      // Collect subsequent tokens that look like file paths
      for (let j = i + 1; j < tokens.length; j++) {
        const candidate = tokens[j];
        if (candidate.startsWith("-")) continue; // skip flags
        if (candidate.includes("/") || /\.(test|spec)\./i.test(candidate) || /\.ts$/.test(candidate)) {
          files.push(candidate);
        }
      }
      break;
    }
  }
  return files;
}

function extractTestRunFiles(events: ToolEvent[]): Set<string> {
  const testFiles = new Set<string>();
  for (const event of events) {
    if (event.tool !== "Bash" || !event.command) continue;
    for (const file of extractBashFilePaths(event.command, TEST_COMMANDS)) {
      testFiles.add(file);
    }
  }
  return testFiles;
}

function wasTestRun(testFile: string, events: ToolEvent[]): boolean {
  for (const event of events) {
    if (event.tool !== "Bash" || !event.command) continue;
    // Only targeted runs with an explicit file path count.
    // Generic commands (npm test, npx vitest) run the full suite - they don't
    // demonstrate intent to verify a specific file, so they shouldn't produce
    // test-after-edit positives for every edited file.
    const files = extractBashFilePaths(event.command, TEST_COMMANDS);
    if (files.some((f) => f === testFile || f.endsWith("/" + testFile) || testFile.endsWith("/" + f))) {
      return true;
    }
  }
  return false;
}

function findTargetedSearches(file: string, fileIdx: number, events: ToolEvent[], graph: PersistedGraph): number {
  // Find first Read of this file
  let firstReadIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].tool === "Read" && events[i].relativePath === file) {
      firstReadIdx = i;
      break;
    }
  }
  if (firstReadIdx === -1) firstReadIdx = fileIdx;

  // Build set of importedNames pointing to this file
  const importedNames = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.to === file) {
      for (const name of edge.importedNames) {
        importedNames.add(name);
      }
    }
  }

  const fileDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const fileBasename = file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file;

  let count = 0;
  for (let i = 0; i < firstReadIdx; i++) {
    const event = events[i];
    if (event.tool !== "Grep" && event.tool !== "Glob") continue;

    let matches = false;

    // Criterion 1: search results included the file
    if (event.resultFiles?.includes(file)) {
      matches = true;
    }

    // Criterion 2: file path/basename contains pattern as substring
    if (!matches && event.pattern) {
      const pattern = event.pattern.toLowerCase();
      if (file.toLowerCase().includes(pattern) || fileBasename.toLowerCase().includes(pattern)) {
        matches = true;
      }
    }

    // Criterion 3: search scoped to same directory
    if (!matches && event.filePath) {
      const searchDir = normalizeSearchPath(event.filePath);
      if (fileDir && searchDir === fileDir) {
        matches = true;
      }
    }

    // Criterion 4: pattern exactly matches an importedNames entry
    if (!matches && event.pattern && importedNames.has(event.pattern)) {
      matches = true;
    }

    if (matches) count++;
  }

  return count;
}

function normalizeSearchPath(searchPath: string): string {
  return searchPath.replace(/\\/g, "/").replace(/\/$/, "");
}

export function detectObservations(
  session: ParsedSession,
  _idealSet: Map<string, IdealFile>,
  graph: PersistedGraph,
  options?: ContextSetOptions,
): Observation[] {
  const coChangeThreshold = options?.coChangeThreshold ?? LEARN.COCHANGE_THRESHOLD;
  const observations: Observation[] = [];
  const events = session.events;
  const modifiedFiles = extractModifiedFiles(events);
  const readFiles = extractReadFiles(events);
  const testRunFiles = extractTestRunFiles(events);

  // blind-edit: Edit without prior Read, deduplicated per file.
  // Only for files in graph.files (established project files). New/untracked files are not actionable.
  const blindEditSeen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.tool !== "Edit" || !event.relativePath) continue;
    const file = event.relativePath;

    // Only emit for established project files
    if (!graph.files[file]) continue;

    // Only emit once per file
    if (blindEditSeen.has(file)) continue;

    // Check if file was read or created (Write) before this Edit
    let wasSeen = false;
    for (let j = 0; j < i; j++) {
      if (events[j].relativePath === file && (events[j].tool === "Read" || events[j].tool === "Write")) {
        wasSeen = true;
        break;
      }
      // Also check Bash cat/head/tail
      const jCommand = events[j].command;
      if (events[j].tool === "Bash" && jCommand) {
        const bashFiles = extractBashFilePaths(jCommand, FILE_READ_COMMANDS);
        if (bashFiles.some((f) => f === file || f.endsWith("/" + file) || file.endsWith("/" + f))) {
          wasSeen = true;
          break;
        }
      }
    }

    // Suppress if file appeared in search results
    if (!wasSeen && wasFileInSearchResults(file, events, i)) {
      wasSeen = true;
    }

    if (!wasSeen) {
      blindEditSeen.add(file);
      observations.push({
        type: "blind-edit",
        section: "file-index",
        file,
        detail: `Edited ${file} without reading it first`,
        eventIndex: i,
      });
    }
  }

  // For Edit-only files, check missed-test, missed-cochange, missed-dependent
  for (const [file, tool] of modifiedFiles) {
    if (tool !== "Edit") continue;

    // missed-test
    const testFiles = graph.testMapping[file] ?? [];
    for (const testFile of testFiles) {
      const testRead = readFiles.has(testFile);
      const testRan = wasTestRun(testFile, events);

      if (testRead || testRan) {
        observations.push({
          type: "test-after-edit",
          section: "test-mapping",
          file,
          relatedFile: testFile,
          detail: `Correctly ran tests after editing ${file}`,
          eventIndex: findLastEditIndex(events, file),
          positive: true,
        });
      } else {
        observations.push({
          type: "missed-test",
          section: "test-mapping",
          file,
          relatedFile: testFile,
          detail: `Edited ${file} but never read ${testFile}`,
          eventIndex: findLastEditIndex(events, file),
        });
      }
    }

    // missed-cochange
    for (const coupling of graph.changeCoupling) {
      let partner: string | undefined;
      if (coupling.fileA === file) partner = coupling.fileB;
      else if (coupling.fileB === file) partner = coupling.fileA;
      if (!partner) continue;
      if (coupling.confidence < coChangeThreshold) continue;

      const partnerRead = readFiles.has(partner);
      const partnerEdited = modifiedFiles.has(partner);

      if (partnerEdited) {
        observations.push({
          type: "cochange-edited",
          section: "change-coupling",
          file,
          relatedFile: partner,
          detail: `Correctly edited co-change partner ${partner} after editing ${file}`,
          eventIndex: findLastEditIndex(events, file),
          positive: true,
        });
      } else if (partnerRead) {
        observations.push({
          type: "cochange-checked",
          section: "change-coupling",
          file,
          relatedFile: partner,
          detail: `Read co-change partner ${partner} to verify compatibility (${Math.round(coupling.confidence * 100)}% confidence)`,
          eventIndex: findLastEditIndex(events, file),
          positive: true,
        });
      } else {
        observations.push({
          type: "missed-cochange",
          section: "change-coupling",
          file,
          relatedFile: partner,
          detail: `Edited ${file} but not co-change partner ${partner} (${Math.round(coupling.confidence * 100)}% confidence)`,
          eventIndex: findLastEditIndex(events, file),
        });
      }
    }

    // missed-dependent: significant importers not read
    for (const edge of graph.edges) {
      if (edge.to !== file) continue;
      if (edge.importedNames.length === 0) continue;

      const dependent = edge.from;
      const depRecord = graph.files[dependent];
      if (!depRecord) continue;
      if (depRecord.importedByCount <= 5 && !depRecord.isChokepoint) continue;

      if (!readFiles.has(dependent) && !modifiedFiles.has(dependent)) {
        observations.push({
          type: "missed-dependent",
          section: "key-files",
          file,
          relatedFile: dependent,
          detail: `Edited ${file} but never read significant dependent ${dependent}`,
          eventIndex: findLastEditIndex(events, file),
        });
      }
    }
  }

  // search-then-find (deduplicated per file)
  const searchThenFindSeen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.tool !== "Read" || !event.relativePath) continue;
    const file = event.relativePath;
    if (!graph.files[file]) continue;
    if (searchThenFindSeen.has(file)) continue;

    const count = findTargetedSearches(file, i, events, graph);
    if (count >= 3) {
      searchThenFindSeen.add(file);
      observations.push({
        type: "search-then-find",
        section: "file-index",
        file,
        detail: `${count} targeted searches before finding ${file}`,
        eventIndex: i,
      });
    }
  }

  // re-read: same file read 2+ times with 2+ intervening actions
  const readIndices = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.tool === "Read" && event.relativePath) {
      const indices = readIndices.get(event.relativePath) ?? [];
      indices.push(i);
      readIndices.set(event.relativePath, indices);
    }
  }
  for (const [file, indices] of readIndices) {
    if (indices.length < 2) continue;
    const firstIdx = indices[0];
    const lastIdx = indices[indices.length - 1];
    const intervening = lastIdx - firstIdx - 1;
    if (intervening >= 2) {
      observations.push({
        type: "re-read",
        section: "code-snapshot",
        file,
        detail: `Read ${file} ${indices.length} times (${intervening} actions between first and last read)`,
        eventIndex: lastIdx,
      });
    }
  }

  // failed-search: search with no results, pattern matches a graph file
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.tool !== "Grep" && event.tool !== "Glob") continue;
    if (event.succeeded) continue;
    if (!event.pattern) continue;

    const patternLower = event.pattern.toLowerCase();
    let matchedFile: string | undefined;

    // Rule 1: path substring match
    for (const filePath of Object.keys(graph.files)) {
      if (filePath.toLowerCase().includes(patternLower)) {
        matchedFile = filePath;
        break;
      }
    }

    // Rule 2: exact export name match
    if (!matchedFile) {
      for (const edge of graph.edges) {
        if (edge.importedNames.includes(event.pattern)) {
          matchedFile = edge.to;
          break;
        }
      }
    }

    if (matchedFile) {
      observations.push({
        type: "failed-search",
        section: "file-index",
        file: matchedFile,
        detail: `Searched for "${event.pattern}" with no results; graph contains ${matchedFile}`,
        eventIndex: i,
      });
    }
  }

  // wasted-test: ran a test file not mapped to any edited file
  const allEditedFiles = [...modifiedFiles.keys()];
  const mappedTests = new Set<string>();
  for (const edited of allEditedFiles) {
    for (const test of graph.testMapping[edited] ?? []) {
      mappedTests.add(test);
    }
  }

  for (const testFile of testRunFiles) {
    // Normalize: check if this path matches any graph file
    let normalizedTest = testFile;
    if (!graph.files[testFile]) {
      // Try to find a matching graph file
      const match = Object.keys(graph.files).find(
        (f) => f === testFile || f.endsWith("/" + testFile) || testFile.endsWith("/" + f),
      );
      if (match) normalizedTest = match;
    }

    if (!mappedTests.has(normalizedTest) && graph.files[normalizedTest]) {
      observations.push({
        type: "wasted-test",
        section: "test-mapping",
        file: normalizedTest,
        detail: `Ran ${normalizedTest} (not mapped to any edited file)`,
        eventIndex: findBashTestIndex(events, testFile),
      });
    }
  }

  return observations;
}

function findLastEditIndex(events: ToolEvent[], file: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i].tool === "Edit" || events[i].tool === "Write") && events[i].relativePath === file) {
      return i;
    }
  }
  return 0;
}

function findBashTestIndex(events: ToolEvent[], testFile: string): number {
  for (let i = 0; i < events.length; i++) {
    if (events[i].tool === "Bash" && events[i].command?.includes(testFile)) {
      return i;
    }
  }
  return 0;
}
