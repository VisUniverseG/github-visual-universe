# Spike: TypeScript 7 compatibility

- **Date:** 2026-10-27
- **Question:** Can the foundation use TypeScript 7 (npm `latest` = 7.0.2) with the selected Vite,
  React, ESLint and Vitest versions?
- **Conclusion:** **Not yet.** The blocker is `typescript-eslint`, not our code or the compiler.
  The foundation pins TypeScript **6.0.3** ([ADR 0002](../adr/0002-typescript-version.md)).

## Method and results

### 1. Peer-dependency declarations (npm registry)

| Package                      | Declared constraint on TypeScript                                             |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `typescript-eslint@8.72.1`   | peer `typescript >=4.8.4 <6.1.0` → **excludes 7.x**                           |
| `vite@8.3.5`                 | none                                                                          |
| `@vitejs/plugin-react@6.1.2` | none                                                                          |
| `vitest@5.0.5`               | none (requires `vite ^6.4 \|\| ^7 \|\| ^8`, Node `^22.12 \|\| ^24 \|\| >=26`) |
| `eslint@10.13.0`             | none                                                                          |
| `react` / `react-dom` 19.3.1 | none (types come from `@types/react*`)                                        |

### 2. Install attempt in a scratch directory (`npm install --dry-run`)

- `typescript@7.0.2 + typescript-eslint@8.72.1 + eslint@10.13.0` → **`ERESOLVE`**: "peer
  typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.72.1".
- `typescript@6.0.3 + typescript-eslint@8.72.1 + eslint@10.13.0` → resolves cleanly.

### 3. Does typescript-eslint have a TS 7-ready release?

`dist-tags`: `latest` 8.72.1, `canary` 8.72.2-alpha.2. The four newest releases (including the
canary) all declare `>=4.8.4 <6.1.0`. **No TS 7-ready release exists** as of this date.

### 4. Does our scaffold compile under the TypeScript 7 compiler? (informational)

TypeScript 7.0.2 was installed in a scratch directory outside the repository, and its `tsc` was run
against each workspace's `tsconfig.json` with `--noEmit`:

| Workspace         | Result   |
| ----------------- | -------- |
| `packages/shared` | 0 errors |
| `apps/api`        | 0 errors |
| `apps/web`        | 0 errors |

So the scaffold is **already type-compatible** with TypeScript 7.0.2. Typed linting
(`typescript-eslint`) was **not** tested under TS 7, because the package manager blocks that
combination and forcing it would produce an unsupported configuration.

## Why not force it?

`--force` / `--legacy-peer-deps` would install a combination that `typescript-eslint` explicitly
says it does not support. A lint setup that silently misbehaves is worse than a lagging compiler
version, especially for a project whose security posture relies on lint-enforced rules (for example,
the planned read-only GitHub client wrapper).

## Re-test procedure (when `typescript-eslint` adds TS 7 support)

1. Confirm: `npm view typescript-eslint@latest peerDependencies.typescript` includes `7`.
2. On a branch, update `typescript` and `typescript-eslint` together (exact pins).
3. Run `npm install`, then `npm run check` and `npm run audit:deps`.
4. Re-check Vite, Vitest and `@vitejs/plugin-react` peer ranges for TypeScript constraints.
5. If green, update ADR 0002 to "Superseded".

## Assumptions and limits

- Registry facts reflect the state on 2026-10-27.
- The compiler check used only `tsc --noEmit`; it did not exercise editor tooling or the TypeScript
  JS API as used by third-party tools.
