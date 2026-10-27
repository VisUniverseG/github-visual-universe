# ADR 0002: Pin TypeScript 6.0.3; defer TypeScript 7

- **Status:** Accepted
- **Date:** 2026-10-27
- **Evidence:** [TypeScript 7 compatibility spike](../spikes/typescript-7-compatibility.md)

## Context

The npm `latest` tag for `typescript` is 7.0.2. The foundation uses ESLint with typed linting via
`typescript-eslint`. The latest `typescript-eslint` (8.72.1) declares the peer range
`typescript >=4.8.4 <6.1.0`, so npm refuses to install TypeScript 7 alongside it.

## Decision

Pin **TypeScript 6.0.3**, the newest stable release inside the supported range of the selected
tooling. Do not use `--force` or `--legacy-peer-deps` to work around the conflict.

## Consequences

- The toolchain resolves cleanly and the full check suite passes.
- We lag the TypeScript major version until the lint tooling catches up.
- The spike shows our code already type-checks under TypeScript 7.0.2, so migration is expected to
  be low-risk once `typescript-eslint` supports it.

## Revisit when

A `typescript-eslint` release declares support for TypeScript 7. Then follow the re-test procedure
in the spike document.
