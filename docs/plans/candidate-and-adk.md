# Candidate and ADK implementation plan

Design inputs: [TS port](../designs/ts-port.md), candidate verification and ADK designs. Tickets: #4, #8.

1. Bind fixed command checks and a fresh read-only review to a frozen bounded Git candidate.
2. Revalidate candidate bytes before accepting both new and replayed approval.
3. Demonstrate standalone and two-parent reuse in disposable repositories.
4. Inspect an exact official ADK TS package and implement the existing Harness contract with truthful usage accounting.
5. Exercise actual SDK agents/graphs with local deterministic models, cancellation, failures, and no-resend replay.

Acceptance: changed candidate cannot inherit acceptance; ADK proof makes no provider request; old supervised improvement tests still pass.
