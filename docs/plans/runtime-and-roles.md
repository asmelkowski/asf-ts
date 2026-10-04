# Runtime and roles implementation plan

Design inputs: [TS port](../designs/ts-port.md), composition and profiles designs. Tickets: #2, #3.

1. Add immutable definition/result contracts, durable invocation ancestry, logical limits, and deadlines.
2. Route child scopes through the existing root run/store and atomic reservations.
3. Add durable local receipts and exact definition inspection without changing old accounting rows.
4. Resolve profiles against trusted bindings and reject unsupported strict requirements before dispatch.
5. Test standalone/two-parent composition, corrections, restart, cancellation, uncertain locals, profile precedence, and session incompatibility.

Acceptance: changed contracts cannot replay; descendants cannot bypass limits; old runtime/session/accounting tests pass. Review runtime and profile PRs separately before merging.
