import type { Turn } from "./parse-session";

/** Phase of a conversation turn */
export type Phase = "explore" | "edit" | "tail";

/** A turn annotated with its phase classification */
export interface ClassifiedTurn extends Turn {
  phase: Phase;
}

/** Tools that count as editing */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Check if a turn contains an edit action */
export function isEditTurn(turn: Turn): boolean {
  return turn.tools.some((t) => EDIT_TOOLS.has(t.name));
}

/**
 * Classify turns into phases:
 * - explore: before first edit
 * - edit: between first and last edit (inclusive)
 * - tail: after last edit
 */
export function classifyTurns(turns: Turn[]): ClassifiedTurn[] {
  const firstEditIdx = turns.findIndex(isEditTurn);
  const lastEditIdx = findLastIndex(turns, isEditTurn);

  return turns.map((turn) => {
    let phase: Phase;
    if (firstEditIdx === -1) {
      // No edits at all - everything is exploration
      phase = "explore";
    } else if (turn.index < firstEditIdx) {
      phase = "explore";
    } else if (turn.index > lastEditIdx) {
      phase = "tail";
    } else {
      phase = "edit";
    }
    return { ...turn, phase };
  });
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}
