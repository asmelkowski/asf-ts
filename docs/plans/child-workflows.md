# Child workflow implementation plan

Source designs: [child workflows](../designs/child-workflows.md), [TS port](../designs/ts-port.md), and [profiles](../designs/profiles.md). Tickets: [#2](https://github.com/asmelkowski/asf-ts/issues/2), runtime seam for [#6](https://github.com/asmelkowski/asf-ts/issues/6).

1. Add typed definition, result, options, schema compiler, and frozen JSON selection in `composition.ts`.
2. Add immutable definition/source/binding and ancestor usage tables in Store. Keep original schema v1 tables and inspection behavior.
3. Bind Runtime and Scope workflow calls to one owner. Add durable local callbacks and namespace checks. Retain raw results before validation.
4. Reserve logical ancestor turns in the native reservation transaction. Keep paid budgets and session compare-and-swap. Propagate persisted deadlines and cancellation.
5. Add a parallel group that aborts on a thrown failure and drains all started work. Preserve negative business verdicts.
6. Verify public behavior and original-v1 migration with account-free fixtures. Run existing tests, typecheck, lint, format, and build. Obtain independent Standards and Spec review of the pinned commit.

Portable lowering, profiles, the editor, and candidate verification use these public seams through their own linked plans. This plan does not implement a new native framework or a live provider probe.
