/**
 * The slideshow, as a pure reducer.
 *
 * This runs unattended on a television for five hours while nobody is looking at
 * the machine it is running on, which is the only requirement that matters and
 * the reason all of the logic is here rather than in the component: a slideshow
 * that stops is worse than a slideshow that skips, and every rule below is
 * chosen so that *something* keeps being on screen.
 *
 * - **New approvals never restart the show.** The playlist grows; the index
 *   follows the id it was on, not the position. A host approving eight photos
 *   mid-slide must not send the television back to the beginning.
 * - **A photo that will not load is skipped, permanently.** An expired signed
 *   URL, a storage hiccup, a codec the machine does not have: `broken` remembers
 *   it, `advance` steps over it, and the show carries on. The alternative — a
 *   black rectangle for eight seconds, every rotation — is exactly what a guest
 *   photographs and sends to the host.
 * - **Every rotation is bounded.** `advance` walks at most one full lap, so a
 *   playlist where everything is broken lands on nothing rather than spinning.
 * - **Shuffle is the client's job** (`slideshow.feed` says so, and it is right:
 *   the server's order has to be stable for its cursor to mean anything). So
 *   `source` keeps arrival order for ever and `playlist` is a view of it —
 *   which is what makes switching back to chronological mid-party lossless.
 *
 * Randomness is injected rather than reached for. `Math.random` in a reducer is
 * a reducer that cannot be tested, and "the shuffle put the same photo on twice"
 * is precisely the kind of report that needs a failing test rather than an
 * evening of staring at a television.
 */

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

/** Seconds a photo holds. The middle value is the default. */
export const SLIDE_DURATION_OPTIONS: readonly number[] = [3, 5, 8, 12, 20];

export const DEFAULT_SLIDE_SECONDS = 5;

/** How long a crossfade takes. Also the CSS transition duration. */
export const CROSSFADE_MS = 700;

/**
 * How long to wait for one slide's media before giving up on it.
 *
 * Generous, because the first paint of a 3 MB photo over a party's wifi is not
 * instant and skipping it would be wrong. Videos get their own, longer budget:
 * a sixty-second clip that has not started playing after twelve seconds is a
 * clip that is not going to.
 */
export const MEDIA_LOAD_TIMEOUT_MS = 8_000;
export const VIDEO_LOAD_TIMEOUT_MS = 12_000;

export function clampSlideSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_SLIDE_SECONDS;
  const first = SLIDE_DURATION_OPTIONS[0] ?? DEFAULT_SLIDE_SECONDS;
  const last = SLIDE_DURATION_OPTIONS.at(-1) ?? DEFAULT_SLIDE_SECONDS;
  return Math.min(last, Math.max(first, Math.round(seconds)));
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type SlideOrder = "chronological" | "shuffle";

export interface SlideshowState {
  readonly order: SlideOrder;
  /** Every approved id ever seen, in the order the feed produced it. */
  readonly source: readonly string[];
  /** The play order. Chronological is `source`; shuffle is a permutation of it. */
  readonly playlist: readonly string[];
  readonly index: number;
  readonly paused: boolean;
  /** Ids whose media failed to load. Skipped, and never retried in this session. */
  readonly broken: ReadonlySet<string>;
  readonly slideSeconds: number;
  /** Audio is opt-in and off by default — a television in a room of people. */
  readonly muted: boolean;
}

export const initialSlideshowState: SlideshowState = {
  order: "chronological",
  source: [],
  playlist: [],
  index: 0,
  paused: false,
  broken: new Set<string>(),
  slideSeconds: DEFAULT_SLIDE_SECONDS,
  muted: true,
};

/** Deterministic in tests, `Math.random` in a browser. Returns 0 ≤ n < 1. */
export type Rng = () => number;

export type SlideshowAction =
  /** A page from `slideshow.feed`. Ids already seen are ignored. */
  | { readonly type: "appended"; readonly ids: readonly string[]; readonly rng: Rng }
  /**
   * The **whole** playlist, authoritatively: add what is new, drop what is gone.
   *
   * `appended` cannot express removal, which meant a photograph a host declined
   * or revoked mid-party kept cycling on the television for the rest of the
   * session. Reconciling is how a host's takedown reaches the wall — and if the
   * item being removed is the one on screen, the index lands on whatever
   * followed it, so the show steps forward rather than stalling on a gap.
   */
  | { readonly type: "reconciled"; readonly ids: readonly string[]; readonly rng: Rng }
  | { readonly type: "setOrder"; readonly order: SlideOrder; readonly rng: Rng }
  /** Flip between the two orders without having to know which one is current. */
  | { readonly type: "toggleOrder"; readonly rng: Rng }
  /** `+1` for skip, `-1` for back. */
  | { readonly type: "advance"; readonly by: number }
  /**
   * "This slide is finished" — from a photo's timer or a video's `ended`.
   *
   * Named rather than blind, and that is the point: a timer belonging to a slide
   * the host has already skipped past fires a moment later and would otherwise
   * advance the slide that replaced it, skipping it after half a second. Naming
   * the sender makes a late timer a no-op.
   */
  | { readonly type: "advanceFrom"; readonly id: string }
  | { readonly type: "togglePause" }
  | { readonly type: "setPaused"; readonly paused: boolean }
  | { readonly type: "setSlideSeconds"; readonly seconds: number }
  | { readonly type: "toggleMuted" }
  /** This slide's media did not load. Skip it and never come back. */
  | { readonly type: "failed"; readonly id: string }
  /** Jump straight to an id — used by "play from here" in a gallery. */
  | { readonly type: "jumpTo"; readonly id: string };

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

export function slideshowReducer(state: SlideshowState, action: SlideshowAction): SlideshowState {
  switch (action.type) {
    case "appended": {
      const known = new Set(state.source);
      const fresh = action.ids.filter((id) => !known.has(id) && !state.broken.has(id));
      if (fresh.length === 0) return state;

      const source = [...state.source, ...fresh];
      const current = currentId(state);

      if (state.order === "chronological") {
        return {
          ...state,
          source,
          playlist: source,
          index: indexOfOr(source, current, state.index),
        };
      }

      /*
       * Shuffle: each new photo is dropped in at a random position *after* the
       * one on screen. Appending at the end would mean a photo taken now is not
       * seen until the whole party has cycled, which at 200 photos and 8 seconds
       * is half an hour — and "my photo never came up" is the single most common
       * complaint a shuffled slideshow generates.
       */
      const playlist = [...state.playlist];
      const from = state.playlist.length === 0 ? 0 : state.index + 1;
      for (const id of fresh) {
        const span = playlist.length - from + 1;
        const at = from + Math.floor(clampUnit(action.rng()) * Math.max(1, span));
        playlist.splice(Math.min(at, playlist.length), 0, id);
      }

      return { ...state, source, playlist, index: indexOfOr(playlist, current, state.index) };
    }

    case "reconciled": {
      const authorised = new Set(action.ids);
      const removed = state.source.some((id) => !authorised.has(id));
      if (!removed) {
        // Nothing to take away — this is an ordinary page, so it is exactly
        // `appended` and shares its shuffle-insertion behaviour.
        return slideshowReducer(state, { type: "appended", ids: action.ids, rng: action.rng });
      }

      const known = new Set(state.source);
      const fresh = action.ids.filter((id) => !known.has(id) && !state.broken.has(id));
      const source = [...state.source.filter((id) => authorised.has(id)), ...fresh];

      // Broken ids are pruned too. They are a per-session skip list, and an id
      // that has left the party has no business keeping a slot in it — nor in
      // barring itself if the host approves it again later.
      const broken = new Set([...state.broken].filter((id) => authorised.has(id)));

      const current = currentId(state);
      const survives = current !== undefined && authorised.has(current);

      const playlist =
        state.order === "chronological"
          ? source
          : [...state.playlist.filter((id) => authorised.has(id)), ...fresh];

      /*
       * Where to stand once the ground has moved.
       *
       * If what was on screen is still approved, follow it — a removal
       * elsewhere in the playlist must not cut away from the room's photograph.
       * If it has gone, count the survivors that were ahead of it: that lands
       * exactly on whatever came next, so the show advances instead of jumping.
       */
      const index = survives
        ? indexOfOr(playlist, current, state.index)
        : Math.min(
            state.playlist.slice(0, state.index).filter((id) => authorised.has(id)).length,
            Math.max(0, playlist.length - 1),
          );

      const settled: SlideshowState = { ...state, source, playlist, broken, index };
      // The landing spot can itself be a slide that failed to load earlier.
      const at = settled.playlist[settled.index];
      if (at !== undefined && settled.broken.has(at)) {
        return { ...settled, index: stepIndex(settled, 1) };
      }
      return settled;
    }

    case "setOrder": {
      if (action.order === state.order) return state;
      const current = currentId(state);
      const playlist =
        action.order === "chronological" ? state.source : shuffled(state.source, action.rng);
      return {
        ...state,
        order: action.order,
        playlist,
        // Stay on the photo that is on screen. Switching the order is a
        // decision about what comes *next*, not a cut.
        index: indexOfOr(playlist, current, 0),
      };
    }

    case "toggleOrder":
      return slideshowReducer(state, {
        type: "setOrder",
        order: state.order === "shuffle" ? "chronological" : "shuffle",
        rng: action.rng,
      });

    case "advance": {
      const next = stepIndex(state, action.by);
      return next === state.index ? state : { ...state, index: next };
    }

    case "advanceFrom": {
      if (currentId(state) !== action.id) return state;
      const next = stepIndex(state, 1);
      return next === state.index ? state : { ...state, index: next };
    }

    case "togglePause":
      return { ...state, paused: !state.paused };

    case "setPaused":
      return state.paused === action.paused ? state : { ...state, paused: action.paused };

    case "setSlideSeconds": {
      const seconds = clampSlideSeconds(action.seconds);
      return seconds === state.slideSeconds ? state : { ...state, slideSeconds: seconds };
    }

    case "toggleMuted":
      return { ...state, muted: !state.muted };

    case "failed": {
      if (state.broken.has(action.id)) return state;
      const broken = new Set(state.broken);
      broken.add(action.id);
      const marked: SlideshowState = { ...state, broken };
      // Only move if the failure is the thing on screen. A preload failing three
      // slides ahead must not cut away from what the room is looking at.
      if (currentId(state) !== action.id) return marked;
      return { ...marked, index: stepIndex(marked, 1) };
    }

    case "jumpTo": {
      const at = state.playlist.indexOf(action.id);
      if (at === -1 || at === state.index) return state;
      return { ...state, index: at };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading it                                                                 */
/* -------------------------------------------------------------------------- */

export function currentId(state: SlideshowState): string | undefined {
  return state.playlist[state.index];
}

/** What to preload. One ahead is enough and costs one request. */
export function upcomingId(state: SlideshowState): string | undefined {
  const at = stepIndex(state, 1);
  const id = state.playlist[at];
  return id === currentId(state) ? undefined : id;
}

/** Everything still in rotation. `playlist` minus what failed to load. */
export function playableCount(state: SlideshowState): number {
  return state.playlist.filter((id) => !state.broken.has(id)).length;
}

/** "12 of 240" — the position counter, counting only what can actually play. */
export function positionLabel(state: SlideshowState): string {
  const total = playableCount(state);
  if (total === 0) return "";
  const current = currentId(state);
  if (current === undefined) return "";
  const seen = state.playlist
    .slice(0, state.index + 1)
    .filter((id) => !state.broken.has(id)).length;
  return `${String(seen)} of ${String(total)}`;
}

/**
 * Step the index, skipping anything broken, and never walking more than one lap.
 *
 * The lap bound is the whole safety property: a playlist in which everything has
 * failed returns the index it was given rather than looping for ever inside a
 * reducer, and React renders an empty stage with an honest message.
 */
function stepIndex(state: SlideshowState, by: number): number {
  const length = state.playlist.length;
  if (length === 0) return 0;

  const step = by === 0 ? 1 : by > 0 ? 1 : -1;
  const distance = Math.max(1, Math.abs(Math.trunc(by)));

  let index = state.index;
  for (let moved = 0; moved < distance; moved += 1) {
    let candidate = index;
    for (let lap = 0; lap < length; lap += 1) {
      candidate = (candidate + step + length) % length;
      const id = state.playlist[candidate];
      if (id !== undefined && !state.broken.has(id)) break;
    }
    index = candidate;
  }
  return index;
}

function indexOfOr(playlist: readonly string[], id: string | undefined, fallback: number): number {
  if (id !== undefined) {
    const at = playlist.indexOf(id);
    if (at !== -1) return at;
  }
  return Math.min(Math.max(0, fallback), Math.max(0, playlist.length - 1));
}

/** Fisher–Yates, with the randomness handed in. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(clampUnit(rng()) * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 1 ? 0.999_999_999 : value;
}

/** `Math.random`, wrapped so call sites read as "the real one". */
export const systemRng: Rng = () => Math.random();
