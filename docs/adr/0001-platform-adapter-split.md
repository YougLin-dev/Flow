# 0001: Split the platform adapter into a facade and focused modules

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Flow maintainers

## Context

Leafer's platform adapter had grown to 1,684 lines in
`src/leafer/nsh-platform.ts`. Geometry, path recording, paint records,
operation replay, the Canvas 2D recording context, the fake canvas surface and
Leafer's platform installation were interleaved in one file. Changes to one
concern required reading and testing the whole file, and the public surface
was not distinguishable from implementation details.

## Decision

Keep `src/leafer/nsh-platform.ts` as the adapter's public facade and move the
implementation into `src/leafer/platform/`, one responsibility per module:

- `geometry.ts`, `values.ts`, `image.ts`, `canvas.ts`, `op.ts` — shared types
  and narrowing helpers
- `path.ts`, `hit-test.ts` — path recording and geometry-based hit testing
- `paint.ts`, `snapshot.ts` — paint records and offscreen snapshots
- `replay.ts`, `recording-context.ts` — recording and replay
- `surface.ts`, `host.ts`, `frame.ts`, `measure.ts` — canvas surfaces and the
  NSH/Leafer runtime boundary

The facade re-exports the same public names, including the `Point` and `Matrix`
types. Consumers (the view, pages and tests) continue to import the facade.
Internal modules import one another directly; the dependency graph stays
acyclic.

## Consequences

- Each module can be read, tested and changed without loading the whole
  adapter; the `max-lines` lint rule prevents a return to a monolith.
- The facade is the only stable surface. Moving code between internal modules
  is not a public API change; adding or removing a facade export is.
- A behavior-preserving split still needs the adapter tests and the full gate;
  this change kept the recorded/replay semantics and added tests for text
  measurement, snapshot alpha/transform composition and hit geometry.
- Future adapter capabilities go into the matching module and are exported
  through the facade only when app code needs them.

## Alternatives considered

- **Keep one file.** Rejected: the file was already too large to review
  safely, and the split needed no behavior change.
- **Split by technical layer only** (types, functions, classes). Rejected:
  it would still put unrelated responsibilities in one file and leave the
  public surface unclear.
- **Move each concern into the app layer** (`flow/`, `pages/`). Rejected:
  Leafer and NSH internals must stay behind one adapter boundary.
