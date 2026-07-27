# @partybooth/config-typescript

Shared strict TypeScript presets. Add `"@partybooth/config-typescript": "workspace:*"` to
your package's `devDependencies`, then extend one of:

| Preset                                       | Use for                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `@partybooth/config-typescript/base.json`    | Anything (platform-agnostic; DOM types **not** included)                 |
| `@partybooth/config-typescript/library.json` | `packages/*` source-only internal packages (`packages/env`, `contracts`) |
| `@partybooth/config-typescript/node.json`    | Node scripts and `packages/backend` (Convex functions)                   |
| `@partybooth/config-typescript/next.json`    | `apps/web`                                                               |
| `@partybooth/config-typescript/expo.json`    | `apps/mobile`                                                            |

## Rules for consumers

1. **The presets never declare `include`/`exclude`.** TypeScript resolves those relative to
   the file that declares them, so a shared preset cannot express them usefully. Declare them
   in your own `tsconfig.json`.
2. **`baseUrl`/`paths` belong to the consuming package**, for the same reason.
3. `noEmit: true` is on everywhere. Internal packages are consumed as TypeScript **source**
   (see the root README) — nothing in `packages/*` is compiled to `dist/` in Sprint 1.

## Example — an internal package

```json
{
  "extends": "@partybooth/config-typescript/library.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## Example — apps/web

```json
{
  "extends": "@partybooth/config-typescript/next.json",
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

## Example — apps/mobile

Array `extends` lets you layer Expo's own base underneath ours (ours wins):

```json
{
  "extends": ["expo/tsconfig.base", "@partybooth/config-typescript/expo.json"],
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"],
  "exclude": ["node_modules"]
}
```
