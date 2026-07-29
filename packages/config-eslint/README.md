# @partybooth/config-eslint

Shared ESLint **flat** config (ESLint 10 + typescript-eslint 8). Add
`"@partybooth/config-eslint": "workspace:*"` and `"eslint": "catalog:"` to your package's
`devDependencies`, then create `eslint.config.mjs` in the package root:

```js
// packages/backend/eslint.config.mjs
import config from "@partybooth/config-eslint/node";
export default config;
```

| Entry point                       | Use for                                         |
| --------------------------------- | ----------------------------------------------- |
| `@partybooth/config-eslint/base`  | Plain TS packages (`packages/contracts`, `env`) |
| `@partybooth/config-eslint/node`  | Node scripts, `packages/backend` (Convex)       |
| `@partybooth/config-eslint/react` | Any React code                                  |
| `@partybooth/config-eslint/next`  | `apps/web`                                      |
| `@partybooth/config-eslint/expo`  | `apps/mobile`                                   |

Each package gets its own `"lint": "eslint ."` script; Turborepo runs them in parallel.

## Things you will hit

- **`process.env` is a lint warning** outside `packages/env`, `*.config.*` and `scripts/`.
  Read config through `@partybooth/env` instead. If you genuinely need a raw read in app code,
  add a scoped `// eslint-disable-next-line no-restricted-syntax` with a reason.
- **Type-aware linting is off on purpose** (no `projectService`). It roughly triples lint time
  and needs per-package project wiring we do not need before 5 Aug. `bun run typecheck` is the
  type gate.
- `eslint-config-prettier` is applied last, so formatting is Prettier's job only.
- Extend, don't fork:

  ```js
  import next from "@partybooth/config-eslint/next";
  export default [...next, { rules: { "@next/next/no-img-element": "off" } }];
  ```
