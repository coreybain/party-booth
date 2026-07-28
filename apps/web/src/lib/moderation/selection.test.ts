import { describe, expect, it } from "vitest";

import type { ModerationRow } from "@/lib/moderation/filters";
import {
  actionAvailability,
  canAct,
  describeModerationResult,
  emptySelection,
  isSelected,
  selectedInOrder,
  selectionReducer,
  type SelectionState,
} from "@/lib/moderation/selection";

const ordered = ["a", "b", "c", "d", "e"];

function reduce(
  state: SelectionState,
  ...actions: Parameters<typeof selectionReducer>[1][]
): SelectionState {
  return actions.reduce(selectionReducer, state);
}

function ids(state: SelectionState): string[] {
  return [...state.ids].sort();
}

function row(overrides: Partial<ModerationRow> & Pick<ModerationRow, "id">): ModerationRow {
  return {
    state: "pending",
    mediaType: "photo",
    uploaderUserId: "u1",
    uploaderDisplayName: "Ada",
    createdAt: 1,
    ...overrides,
  };
}

describe("picking", () => {
  it("toggles on and off and sets the anchor", () => {
    const picked = reduce(emptySelection, { type: "toggle", id: "b" });
    expect(ids(picked)).toEqual(["b"]);
    expect(picked.anchor).toBe("b");
    expect(picked.focus).toBe("b");

    expect(ids(reduce(picked, { type: "toggle", id: "b" }))).toEqual([]);
  });

  it("extends from the anchor in both directions", () => {
    const state = reduce(
      emptySelection,
      { type: "toggle", id: "b" },
      { type: "extend", id: "d", ordered },
    );
    expect(ids(state)).toEqual(["b", "c", "d"]);

    // Dragging back the other way measures from the same anchor.
    expect(ids(reduce(state, { type: "extend", id: "a", ordered }))).toEqual(["a", "b", "c", "d"]);
  });

  it("degrades to a plain pick when one end of the range has gone", () => {
    const state = reduce(
      emptySelection,
      { type: "toggle", id: "z" },
      { type: "extend", id: "c", ordered },
    );
    expect(ids(state)).toEqual(["c", "z"]);
    expect(state.anchor).toBe("c");
  });

  it("selects everything on screen and clears", () => {
    const all = selectionReducer(emptySelection, { type: "selectAll", ordered });
    expect(ids(all)).toEqual([...ordered].sort());
    expect(ids(selectionReducer(all, { type: "clear" }))).toEqual([]);
  });

  it("returns the selection in grid order, not set order", () => {
    const state = reduce(
      emptySelection,
      { type: "toggle", id: "d" },
      { type: "toggle", id: "a" },
      { type: "toggle", id: "c" },
    );
    expect(selectedInOrder(state, ordered)).toEqual(["a", "c", "d"]);
    expect(isSelected(state, "a")).toBe(true);
    expect(isSelected(state, "b")).toBe(false);
  });
});

describe("the keyboard cursor", () => {
  it("starts at the first card when nothing is focused", () => {
    expect(selectionReducer(emptySelection, { type: "move", delta: 1, ordered }).focus).toBe("a");
    expect(selectionReducer(emptySelection, { type: "move", delta: -1, ordered }).focus).toBe("e");
  });

  it("moves by one and by a row, and stops at the ends", () => {
    const at = (focus: string): SelectionState => ({ ...emptySelection, focus });

    expect(selectionReducer(at("b"), { type: "move", delta: 1, ordered }).focus).toBe("c");
    expect(selectionReducer(at("b"), { type: "move", delta: 3, ordered }).focus).toBe("e");
    expect(selectionReducer(at("a"), { type: "move", delta: -1, ordered }).focus).toBe("a");
    expect(selectionReducer(at("e"), { type: "move", delta: 1, ordered }).focus).toBe("e");
  });

  it("does nothing at all when there is nothing to focus", () => {
    const state = selectionReducer(emptySelection, { type: "move", delta: 1, ordered: [] });
    expect(state.focus).toBeUndefined();
  });
});

describe("reconciling with a live grid", () => {
  it("drops ids that are no longer there and keeps the ones that are", () => {
    // A bulk bar that says "Approve 12" and approves 9 is a bulk bar nobody
    // trusts twice.
    const state = reduce(
      emptySelection,
      { type: "toggle", id: "a" },
      { type: "toggle", id: "b" },
      { type: "toggle", id: "c" },
    );
    const after = selectionReducer(state, { type: "reconcile", ordered: ["a", "c"] });
    expect(ids(after)).toEqual(["a", "c"]);
  });

  it("clears a focus and anchor whose cards have gone", () => {
    const state = reduce(emptySelection, { type: "toggle", id: "b" });
    const after = selectionReducer(state, { type: "reconcile", ordered: ["a", "c"] });
    expect(after.focus).toBeUndefined();
    expect(after.anchor).toBeUndefined();
  });

  it("keeps object identity when nothing moved", () => {
    const state = reduce(emptySelection, { type: "toggle", id: "a" });
    expect(selectionReducer(state, { type: "reconcile", ordered })).toBe(state);
  });
});

describe("what the bulk bar may offer", () => {
  const rows = [
    row({ id: "a", state: "pending" }),
    row({ id: "b", state: "approved" }),
    row({ id: "c", state: "declined" }),
    row({ id: "d", state: "processing" }),
  ];
  const selected = new Set(["a", "b", "c", "d"]);

  it("counts only the items an action would actually move", () => {
    expect(actionAvailability(rows, selected, "approve")).toEqual({
      changes: 2, // pending + declined
      unchanged: 1, // already approved
      refuses: 1, // still uploading
    });
  });

  it("refuses revoke for anything that is not approved", () => {
    expect(actionAvailability(rows, selected, "revoke")).toEqual({
      changes: 1,
      unchanged: 0,
      refuses: 3,
    });
  });

  it("greys a card's own button using the same rule", () => {
    expect(canAct(row({ id: "a", state: "pending" }), "approve")).toBe(true);
    expect(canAct(row({ id: "a", state: "approved" }), "approve")).toBe(false);
    expect(canAct(row({ id: "a", state: "approved" }), "revoke")).toBe(true);
    expect(canAct(row({ id: "a", state: "pending" }), "revoke")).toBe(false);
    expect(canAct(row({ id: "a", state: "processing" }), "decline")).toBe(false);
  });

  it("ignores rows outside the selection", () => {
    expect(actionAvailability(rows, new Set(["a"]), "approve")).toEqual({
      changes: 1,
      unchanged: 0,
      refuses: 0,
    });
  });
});

describe("saying what happened", () => {
  it("reports both halves of a partial success", () => {
    expect(
      describeModerationResult({
        changed: 9,
        unchanged: 2,
        refused: [{ message: "The guest withdrew that one." }],
      }),
    ).toBe("9 updated · 2 already done · 1 skipped — the guest withdrew that one.");
  });

  it("does not quote a reason when there are several", () => {
    expect(
      describeModerationResult({
        changed: 0,
        unchanged: 0,
        refused: [{ message: "One." }, { message: "Two." }],
      }),
    ).toBe("2 skipped.");
  });

  it("says something when there was nothing to do", () => {
    expect(describeModerationResult({ changed: 0, unchanged: 0, refused: [] })).toBe(
      "Nothing to do.",
    );
  });
});
