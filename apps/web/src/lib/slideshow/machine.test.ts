import { describe, expect, it } from "vitest";

import {
  clampSlideSeconds,
  currentId,
  DEFAULT_SLIDE_SECONDS,
  initialSlideshowState,
  playableCount,
  positionLabel,
  shuffled,
  slideshowReducer,
  upcomingId,
  type Rng,
  type SlideshowAction,
  type SlideshowState,
} from "@/lib/slideshow/machine";

/** A predictable "random": walks a fixed ring of values. */
function seeded(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const value = values[i % values.length] ?? 0;
    i += 1;
    return value;
  };
}

const zero: Rng = () => 0;

function reduce(state: SlideshowState, ...actions: SlideshowAction[]): SlideshowState {
  return actions.reduce(slideshowReducer, state);
}

function withItems(ids: readonly string[]): SlideshowState {
  return slideshowReducer(initialSlideshowState, { type: "appended", ids, rng: zero });
}

describe("building the playlist", () => {
  it("appends in feed order when chronological", () => {
    const state = reduce(
      initialSlideshowState,
      { type: "appended", ids: ["a", "b"], rng: zero },
      { type: "appended", ids: ["c"], rng: zero },
    );
    expect(state.playlist).toEqual(["a", "b", "c"]);
    expect(currentId(state)).toBe("a");
  });

  it("ignores ids it has already seen", () => {
    const state = reduce(
      initialSlideshowState,
      { type: "appended", ids: ["a", "b"], rng: zero },
      { type: "appended", ids: ["a", "b"], rng: zero },
    );
    expect(state.playlist).toEqual(["a", "b"]);
  });

  it("returns the identical state when a page adds nothing", () => {
    // The feed re-runs on every approval; an empty page is the common case and
    // must not re-render the stage.
    const state = withItems(["a"]);
    expect(slideshowReducer(state, { type: "appended", ids: [], rng: zero })).toBe(state);
    expect(slideshowReducer(state, { type: "appended", ids: ["a"], rng: zero })).toBe(state);
  });

  it("keeps the photo on screen when new ones arrive", () => {
    const state = reduce(
      withItems(["a", "b", "c"]),
      { type: "advance", by: 1 },
      { type: "appended", ids: ["d", "e"], rng: zero },
    );
    expect(currentId(state)).toBe("b");
    expect(state.playlist).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops a shuffled arrival somewhere after the current slide, never before it", () => {
    const shuffledStart = reduce(withItems(["a", "b", "c", "d"]), {
      type: "setOrder",
      order: "shuffle",
      rng: seeded([0.9, 0.1, 0.5]),
    });
    const at = shuffledStart.index;

    const after = slideshowReducer(shuffledStart, {
      type: "appended",
      ids: ["new"],
      rng: seeded([0.9]),
    });

    expect(after.playlist.indexOf("new")).toBeGreaterThan(at);
    expect(currentId(after)).toBe(currentId(shuffledStart));
    expect(after.playlist).toHaveLength(5);
  });
});

describe("order", () => {
  it("keeps the current photo when switching to shuffle and back", () => {
    const start = reduce(withItems(["a", "b", "c", "d"]), { type: "advance", by: 2 });
    expect(currentId(start)).toBe("c");

    const mixed = slideshowReducer(start, {
      type: "setOrder",
      order: "shuffle",
      rng: seeded([0.3, 0.7, 0.1]),
    });
    expect(currentId(mixed)).toBe("c");
    expect([...mixed.playlist].sort()).toEqual(["a", "b", "c", "d"]);

    const back = slideshowReducer(mixed, {
      type: "setOrder",
      order: "chronological",
      rng: zero,
    });
    expect(back.playlist).toEqual(["a", "b", "c", "d"]);
    expect(currentId(back)).toBe("c");
  });

  it("is a no-op when the order is already what was asked for", () => {
    const state = withItems(["a", "b"]);
    expect(slideshowReducer(state, { type: "setOrder", order: "chronological", rng: zero })).toBe(
      state,
    );
  });

  it("shuffles without losing or duplicating anything", () => {
    const source = ["a", "b", "c", "d", "e", "f"];
    const out = shuffled(source, seeded([0.1, 0.9, 0.4, 0.2, 0.7]));
    expect([...out].sort()).toEqual([...source].sort());
    expect(source).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("advancing", () => {
  it("wraps in both directions", () => {
    const state = withItems(["a", "b", "c"]);
    expect(currentId(reduce(state, { type: "advance", by: 1 }))).toBe("b");
    expect(currentId(reduce(state, { type: "advance", by: -1 }))).toBe("c");
    expect(
      currentId(
        reduce(
          state,
          { type: "advance", by: 1 },
          { type: "advance", by: 1 },
          {
            type: "advance",
            by: 1,
          },
        ),
      ),
    ).toBe("a");
  });

  it("does nothing on an empty playlist", () => {
    const state = slideshowReducer(initialSlideshowState, { type: "advance", by: 1 });
    expect(currentId(state)).toBeUndefined();
    expect(state.index).toBe(0);
  });

  it("names what to preload", () => {
    expect(upcomingId(withItems(["a", "b", "c"]))).toBe("b");
    expect(upcomingId(withItems(["a"]))).toBeUndefined();
  });
});

describe("media that will not load", () => {
  it("skips a broken slide and moves on from it", () => {
    const state = reduce(withItems(["a", "b", "c"]), { type: "failed", id: "a" });
    expect(currentId(state)).toBe("b");
    expect(playableCount(state)).toBe(2);
  });

  it("steps over a broken slide when advancing", () => {
    const state = reduce(
      withItems(["a", "b", "c"]),
      { type: "failed", id: "b" },
      { type: "advance", by: 1 },
    );
    expect(currentId(state)).toBe("c");
  });

  it("does not cut away when something further down the list fails", () => {
    const state = reduce(withItems(["a", "b", "c"]), { type: "failed", id: "c" });
    expect(currentId(state)).toBe("a");
  });

  it("never loops for ever when everything is broken", () => {
    // The lap bound is the safety property: an empty stage with an honest
    // message beats a reducer spinning inside React's render.
    const state = reduce(
      withItems(["a", "b"]),
      { type: "failed", id: "a" },
      { type: "failed", id: "b" },
      { type: "advance", by: 1 },
    );
    expect(playableCount(state)).toBe(0);
    expect(positionLabel(state)).toBe("");
  });

  it("remembers a failure rather than retrying it", () => {
    const once = slideshowReducer(withItems(["a", "b"]), { type: "failed", id: "a" });
    expect(slideshowReducer(once, { type: "failed", id: "a" })).toBe(once);
  });
});

describe("controls", () => {
  it("pauses, resumes and mutes", () => {
    const paused = slideshowReducer(withItems(["a"]), { type: "togglePause" });
    expect(paused.paused).toBe(true);
    expect(slideshowReducer(paused, { type: "setPaused", paused: true })).toBe(paused);
    expect(slideshowReducer(paused, { type: "togglePause" }).paused).toBe(false);
    expect(slideshowReducer(paused, { type: "toggleMuted" }).muted).toBe(false);
  });

  it("clamps the slide timing to the offered range", () => {
    expect(clampSlideSeconds(0)).toBe(3);
    expect(clampSlideSeconds(999)).toBe(20);
    expect(clampSlideSeconds(Number.NaN)).toBe(DEFAULT_SLIDE_SECONDS);
    expect(
      slideshowReducer(withItems(["a"]), { type: "setSlideSeconds", seconds: 8 }).slideSeconds,
    ).toBe(8);
  });

  it("toggles between the two orders", () => {
    const state = withItems(["a", "b"]);
    const shuffledOnce = slideshowReducer(state, { type: "toggleOrder", rng: seeded([0.4]) });
    expect(shuffledOnce.order).toBe("shuffle");
    expect(slideshowReducer(shuffledOnce, { type: "toggleOrder", rng: zero }).order).toBe(
      "chronological",
    );
  });

  it("ignores a finished-slide signal from a slide that is no longer showing", () => {
    // A photo timer belonging to a slide the host skipped past fires a moment
    // later; without the id it would skip the slide that replaced it.
    const state = reduce(withItems(["a", "b", "c"]), { type: "advance", by: 1 });
    expect(slideshowReducer(state, { type: "advanceFrom", id: "a" })).toBe(state);
    expect(currentId(slideshowReducer(state, { type: "advanceFrom", id: "b" }))).toBe("c");
  });

  it("jumps to a named slide and ignores one that is not there", () => {
    const state = withItems(["a", "b", "c"]);
    expect(currentId(slideshowReducer(state, { type: "jumpTo", id: "c" }))).toBe("c");
    expect(slideshowReducer(state, { type: "jumpTo", id: "zz" })).toBe(state);
  });

  it("counts the position over what can actually play", () => {
    const state = reduce(withItems(["a", "b", "c"]), { type: "advance", by: 1 });
    expect(positionLabel(state)).toBe("2 of 3");
  });
});
