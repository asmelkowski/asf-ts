# ADK proof plan

Design inputs: [ADK](../designs/adk.md), [TS port](../designs/ts-port.md). Ticket: #8.

1. Source-check the exact SDK and qualify import and execution on Node22.
2. Add the optional Harness with fixed instructions/tools, owned sessions, model and event limits.
3. Capture call usage at the actual BaseLlm seam and retain incomplete evidence.
4. Test actual agent/tool/graph execution, continuation, failure, cancellation, replay, and unsupported policy.
5. Register the account-free proof in a representative portable workflow beside existing Codex and OpenCode SDK fixtures.

Steps 1–4 belong to the adapter slice. Step 5 belongs to the portable integration slice. Acceptance uses no provider requests and preserves the mandatory native accounting contract. Full native-code export remains deferred.
