/**
 * A tiny, dependency-free state-machine helper.
 *
 * Every lifecycle in PartyBooth (accounts, events, media, captures) is a plain
 * `Record<State, readonly State[]>` transition table. Building the validators
 * from one helper means every lifecycle gets the same behaviour — including the
 * two rules that are easy to forget:
 *
 * 1. A transition to the state you are already in is a **no-op, not an error**.
 *    Convex mutations retry, callbacks arrive twice, and the UI double-taps;
 *    idempotence has to be the default.
 * 2. Terminal states are derived from the table, never hand-maintained.
 */
export type TransitionTable<TState extends string> = Readonly<Record<TState, readonly TState[]>>;

export interface StateMachine<TState extends string> {
  readonly states: readonly TState[];
  readonly transitions: TransitionTable<TState>;
  /** `true` if `from → to` is legal. Same-state transitions are always legal. */
  canTransition(from: TState, to: TState): boolean;
  /** States reachable from `from`, excluding `from` itself. */
  nextStates(from: TState): readonly TState[];
  /** `true` when no state other than `from` is reachable. */
  isTerminal(state: TState): boolean;
  /** Throws {@link InvalidTransitionError} unless the transition is legal. */
  assertTransition(from: TState, to: TState): void;
  isState(value: unknown): value is TState;
}

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";

  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[],
  ) {
    super(
      allowed.length > 0
        ? `${entity} cannot move from "${from}" to "${to}" (allowed: ${allowed.join(", ")}).`
        : `${entity} is in terminal state "${from}" and cannot move to "${to}".`,
    );
  }
}

export function createStateMachine<TState extends string>(
  entity: string,
  states: readonly TState[],
  transitions: TransitionTable<TState>,
): StateMachine<TState> {
  const stateSet: ReadonlySet<string> = new Set(states);

  const nextStates = (from: TState): readonly TState[] => transitions[from] ?? [];

  const canTransition = (from: TState, to: TState): boolean =>
    from === to || nextStates(from).includes(to);

  return {
    states,
    transitions,
    canTransition,
    nextStates,
    isTerminal: (state) => nextStates(state).filter((next) => next !== state).length === 0,
    assertTransition(from, to) {
      if (!canTransition(from, to)) {
        throw new InvalidTransitionError(entity, from, to, nextStates(from));
      }
    },
    isState: (value): value is TState => typeof value === "string" && stateSet.has(value),
  };
}
