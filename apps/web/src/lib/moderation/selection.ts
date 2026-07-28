/**
 * Selection and the keyboard cursor for the moderation grid.
 *
 * A pure reducer, for the same reason `upload/machine.ts` is one: the
 * interesting behaviour is entirely in the edge cases, and the edge cases here
 * are produced by *other people*. This grid is live — a co-host approving from
 * their phone, a guest withdrawing a photo, and thirty new uploads all land in
 * the middle of a selection — so every action takes the currently-ordered list
 * and reconciles against it rather than trusting what was on screen when the
 * host started dragging.
 *
 * ## The rules that are easy to get wrong
 *
 * - **A selected item that disappears is deselected.** Otherwise a bulk approve
 *   sends ids for photos the submitter withdrew thirty seconds ago, and the
 *   host reads a row of refusals they did not cause. (`moderation.moderate`
 *   itemises those refusals rather than throwing, so this is politeness rather
 *   than safety — but a bulk bar that says "Approve 12" and approves 9 is a bulk
 *   bar nobody trusts twice.)
 * - **The focus ring survives a reorder.** Approving the card under the cursor
 *   moves it out of the pending band, so the naive "keep index 4" keeps the
 *   host's cursor somewhere they were not looking. Focus is kept **on the id**,
 *   and only falls back to a position when the id is gone.
 * - **Range selection is anchored, not additive.** Shift-click extends from the
 *   last plain click, which is what every file manager does and therefore what
 *   fingers already know.
 *
 * The counts on the bulk buttons come from `moderationTransition` — the very
 * function the Convex mutation runs per item — so "Approve 12" counts the items
 * that would actually move.
 */

import { moderationTransition, type ModerationActionName } from "@/lib/contracts";
import type { ModerationRow } from "@/lib/moderation/filters";

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export interface SelectionState {
  /** Ids the host has picked. Order is the grid's, never this set's. */
  readonly ids: ReadonlySet<string>;
  /** Where a shift-extend measures from. */
  readonly anchor: string | undefined;
  /** The keyboard cursor. Independent of selection: you can review without picking. */
  readonly focus: string | undefined;
}

export const emptySelection: SelectionState = {
  ids: new Set<string>(),
  anchor: undefined,
  focus: undefined,
};

export type SelectionAction =
  /** Plain click or a keyboard toggle. Sets the anchor. */
  | { readonly type: "toggle"; readonly id: string }
  /** Click with the cursor, no selection change. */
  | { readonly type: "focus"; readonly id: string }
  /** Arrow keys. `delta` is ±1 for left/right and ±columns for up/down. */
  | { readonly type: "move"; readonly delta: number; readonly ordered: readonly string[] }
  /** Shift-click or shift-arrow: everything between the anchor and here. */
  | { readonly type: "extend"; readonly id: string; readonly ordered: readonly string[] }
  | { readonly type: "selectAll"; readonly ordered: readonly string[] }
  | { readonly type: "clear" }
  /** The live list changed underneath us. */
  | { readonly type: "reconcile"; readonly ordered: readonly string[] };

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "toggle": {
      const ids = new Set(state.ids);
      if (ids.has(action.id)) ids.delete(action.id);
      else ids.add(action.id);
      return { ids, anchor: action.id, focus: action.id };
    }

    case "focus":
      if (state.focus === action.id) return state;
      return { ...state, focus: action.id };

    case "move": {
      const { ordered } = action;
      if (ordered.length === 0)
        return state.focus === undefined ? state : { ...state, focus: undefined };

      const current = state.focus === undefined ? -1 : ordered.indexOf(state.focus);
      // No cursor yet, or the focused card has gone: an arrow press should land
      // on the first card rather than on nothing, because the host pressed an
      // arrow to *start* reviewing.
      const next =
        current === -1
          ? action.delta > 0
            ? 0
            : ordered.length - 1
          : clampIndex(current + action.delta, ordered.length);

      const id = ordered[next];
      if (id === undefined || id === state.focus) return state;
      return { ...state, focus: id };
    }

    case "extend": {
      const { ordered } = action;
      const from = state.anchor ?? state.focus ?? action.id;
      const start = ordered.indexOf(from);
      const end = ordered.indexOf(action.id);
      if (start === -1 || end === -1) {
        // One end of the range is no longer on screen. Treat it as a plain
        // pick rather than selecting a span nobody asked for.
        const ids = new Set(state.ids);
        ids.add(action.id);
        return { ids, anchor: action.id, focus: action.id };
      }

      const ids = new Set(state.ids);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) {
        const id = ordered[i];
        if (id !== undefined) ids.add(id);
      }
      // The anchor stays put: dragging back and forth from one anchor is the
      // whole point of an anchor.
      return { ids, anchor: from, focus: action.id };
    }

    case "selectAll": {
      const ids = new Set(action.ordered);
      return { ids, anchor: action.ordered[0], focus: state.focus ?? action.ordered[0] };
    }

    case "clear":
      return state.ids.size === 0 && state.focus === undefined
        ? state
        : { ids: new Set<string>(), anchor: undefined, focus: undefined };

    case "reconcile": {
      const present = new Set(action.ordered);
      const ids = new Set<string>();
      for (const id of state.ids) if (present.has(id)) ids.add(id);

      const focus = state.focus !== undefined && present.has(state.focus) ? state.focus : undefined;
      const anchor =
        state.anchor !== undefined && present.has(state.anchor) ? state.anchor : undefined;

      // Identity is preserved when nothing moved so React does not re-render the
      // whole grid on every subscription tick.
      if (ids.size === state.ids.size && focus === state.focus && anchor === state.anchor) {
        return state;
      }
      return { ids, anchor, focus };
    }
  }
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index > length - 1) return length - 1;
  return index;
}

/* -------------------------------------------------------------------------- */
/* Reading it                                                                 */
/* -------------------------------------------------------------------------- */

export function isSelected(state: SelectionState, id: string): boolean {
  return state.ids.has(id);
}

/** Selected ids **in grid order**, which is the order the mutation is given. */
export function selectedInOrder(state: SelectionState, ordered: readonly string[]): string[] {
  return ordered.filter((id) => state.ids.has(id));
}

export interface ActionAvailability {
  /** How many of the selection this action would actually move. */
  readonly changes: number;
  /** How many it would refuse. */
  readonly refuses: number;
  /** How many are already where it would put them. */
  readonly unchanged: number;
}

/**
 * What each bulk button would do to the current selection.
 *
 * Run through `moderationTransition`, not through a local `switch`: the grid
 * must not offer "Revoke 8" for a selection containing five pending items, and
 * the rule that decides is the server's.
 */
export function actionAvailability(
  rows: readonly ModerationRow[],
  selected: ReadonlySet<string>,
  action: ModerationActionName,
): ActionAvailability {
  let changes = 0;
  let refuses = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (!selected.has(row.id)) continue;
    const transition = moderationTransition(action, row.state);
    if (!transition.ok) refuses += 1;
    else if (transition.changed) changes += 1;
    else unchanged += 1;
  }

  return { changes, refuses, unchanged };
}

/** Whether a single card should offer this action at all. */
export function canAct(row: ModerationRow, action: ModerationActionName): boolean {
  const transition = moderationTransition(action, row.state);
  return transition.ok && transition.changed;
}

/**
 * One sentence for a `moderation.moderate` result.
 *
 * Partial success is the contract (see `ModerationResult`), so the host is told
 * both halves — what moved and what did not — in the order they care about.
 * A silent partial failure is the thing that makes a host approve the same photo
 * three times.
 */
export function describeModerationResult(result: {
  readonly changed: number;
  readonly unchanged: number;
  readonly refused: readonly { readonly message: string }[];
}): string {
  const parts: string[] = [];
  if (result.changed > 0) parts.push(`${String(result.changed)} updated`);
  if (result.unchanged > 0) parts.push(`${String(result.unchanged)} already done`);

  if (result.refused.length > 0) {
    // One distinct reason is worth quoting; several is a list nobody reads.
    const reasons = new Set(result.refused.map((refusal) => refusal.message));
    const first = [...reasons][0];
    parts.push(
      reasons.size === 1 && first !== undefined
        ? // `MODERATION_REFUSAL_MESSAGES` are whole sentences and end in a stop;
          // this one is being folded into a longer one, so its own goes.
          `${String(result.refused.length)} skipped — ${first.replace(/\.$/, "").toLowerCase()}`
        : `${String(result.refused.length)} skipped`,
    );
  }

  return parts.length === 0 ? "Nothing to do." : `${parts.join(" · ")}.`;
}
