import { estimateTokens } from "../utils.js";

const INSPECT_TOKEN_CAP = 80;
const IMPACT_TOKEN_CAP = 120;

export interface InspectData {
  role: string;
  betweenness: number;
  instability: number | null;
  chokepoint?: { separates: number };
  integrationTests: string[];
  coChange: Array<{ file: string; confidence: number }>;
  community?: { id: number; label: string };
  crossCutting?: { layerSpread: number; layers: string[] };
}

export interface ImpactData {
  integrationTests: Array<{ file: string; via?: string }>;
  transitiveReach: number;
  hiddenCoChange: Array<{ file: string; confidence: number; coChangeCount: number }>;
  risk: { level: string; reason: string };
  communityCrossing?: { communities: Array<{ id: number; label: string }> };
}

/**
 * Format clarte_inspect response. Enforces 80-token cap by progressively
 * dropping lowest-priority fields.
 *
 * Priority (high to low): role+betweenness, chokepoint, integration-tests,
 * coChange, community, crossCutting
 */
export function formatInspect(data: InspectData): string {
  const lines: string[] = [];

  // Always included: role + betweenness + instability
  const roleLine = buildRoleLine(data);
  lines.push(roleLine);

  // Chokepoint (priority 2)
  if (data.chokepoint) {
    lines.push(`chokepoint: separates ${data.chokepoint.separates} components`);
  }

  // Integration tests (priority 3)
  if (data.integrationTests.length > 0) {
    lines.push(`integration-tests: ${data.integrationTests.join(" | ")}`);
  }

  // Co-change (priority 4)
  if (data.coChange.length > 0) {
    const pairs = data.coChange.map((c) => `${c.file} (${pct(c.confidence)})`);
    lines.push(`cochange: ${pairs.join(" | ")}`);
  }

  // Community (priority 5)
  if (data.community) {
    lines.push(`community: ${data.community.label} (id:${data.community.id})`);
  }

  // Cross-cutting (priority 6)
  if (data.crossCutting) {
    lines.push(`cross-cutting: ${data.crossCutting.layers.join(", ")} (${data.crossCutting.layerSpread} layers)`);
  }

  return enforceTokenCap(lines, INSPECT_TOKEN_CAP, 1);
}

/**
 * Format clarte_impact response. Enforces 120-token cap by progressively
 * dropping lowest-priority fields.
 *
 * Priority (high to low): integration-tests, risk, transitive-reach,
 * hidden-cochange, community-crossing
 */
export function formatImpact(data: ImpactData): string {
  const lines: string[] = [];

  // Integration tests (priority 1)
  if (data.integrationTests.length > 0) {
    const entries = data.integrationTests.map((t) => (t.via ? `${t.file} (transitive via ${t.via})` : t.file));
    lines.push(`integration-tests: ${entries.join(" | ")}`);
  }

  // Risk (priority 2)
  lines.push(`risk: ${data.risk.level} -- ${data.risk.reason}`);

  // Transitive reach (priority 3)
  if (data.transitiveReach > 0) {
    lines.push(`transitive-reach: ${data.transitiveReach} files beyond direct dependents`);
  }

  // Hidden co-change (priority 4)
  if (data.hiddenCoChange.length > 0) {
    const entries = data.hiddenCoChange.map(
      (h) => `${h.file} (${pct(h.confidence)}, ${h.coChangeCount} co-changes, no import path)`,
    );
    lines.push(`hidden-cochange: ${entries.join(" | ")}`);
  }

  // Community crossing (priority 5)
  if (data.communityCrossing) {
    const labels = data.communityCrossing.communities.map((c) => c.label);
    lines.push(`community-crossing: changes span ${labels.join(", ")} (${labels.length} communities)`);
  }

  return enforceTokenCap(lines, IMPACT_TOKEN_CAP, 2);
}

function buildRoleLine(data: InspectData): string {
  const parts = [`role: ${data.role}`, `betweenness: ${pct(data.betweenness)}`];
  if (data.instability !== null) {
    parts.push(`instability: ${pct(data.instability)}`);
  }
  return parts.join(" | ");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Progressively drop lines from the end (lowest priority) and truncate list items
 * until the output fits within the token cap. Always keeps at least `minLines` lines.
 */
function enforceTokenCap(lines: string[], cap: number, minLines: number): string {
  let result = lines.join("\n");
  if (estimateTokens(result) <= cap) return result;

  // First pass: truncate list items in each line (5 -> 3 -> 1)
  for (let maxItems = 3; maxItems >= 1; maxItems--) {
    const truncated = lines.map((line) => truncateListItems(line, maxItems));
    result = truncated.join("\n");
    if (estimateTokens(result) <= cap) return result;
  }

  // Second pass: drop lines from the end
  const trimmed = [...lines];
  while (trimmed.length > minLines && estimateTokens(trimmed.join("\n")) > cap) {
    trimmed.pop();
  }

  return trimmed.join("\n");
}

/**
 * Truncate pipe-delimited items in a line to maxItems.
 */
function truncateListItems(line: string, maxItems: number): string {
  const colonIdx = line.indexOf(": ");
  if (colonIdx < 0) return line;

  const prefix = line.slice(0, colonIdx + 2);
  const value = line.slice(colonIdx + 2);
  const items = value.split(" | ");

  if (items.length <= maxItems) return line;
  return prefix + items.slice(0, maxItems).join(" | ");
}
