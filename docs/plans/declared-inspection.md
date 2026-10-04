# Declared inspection implementation plan

Ticket: [#10](https://github.com/asmelkowski/asf-ts/issues/10). Designs: [declared inspection](../designs/declared-inspection.md), [child workflows](../designs/child-workflows.md), [TS port](../designs/ts-port.md).

1. Add a pure browser DTO and read-only backend projection over existing Store APIs. Verify source digests, contracts, owner namespaces, action kinds, and declared child slots.
2. Preserve independent record windows and total counts. Add one exact focused invocation for receipt paging. Retry inconsistent external SQLite snapshots with a finite bound.
3. Add isolated graph assets with text-only evidence rendering, keyboard node selection, child links, receipt drill-down, and separate lifecycle and business verdicts.
4. Test actual portable execution receipts and original v1 stores. Test partial and corrupted data without fabricating node states.
5. Integrate GET-only routes under the existing HTTP guards. Run an actual headless browser walkthrough, typecheck, lint, format, and relevant runtime/HTTP tests. Obtain independent Standards and Spec review of the pinned head.

No plan step reads private native session files or invokes a live provider. The existing observation map remains the view for ordinary code-authored runs.
