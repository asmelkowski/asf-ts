# Editor and inspection implementation plan

Design inputs: [TS port](../designs/ts-port.md), portable and composition designs. Tickets: #9, #10.

1. Add a local authoring route and catalogue-driven forms for nodes, profiles, schemas, transitions, and children.
2. Keep imported source and invalid form drafts authoritative; disable export on every edit and reject stale validation replies.
3. Add JSON/YAML download/reopen and layout editing. Use the shared validator.
4. Add declared-graph inspection from persisted definitions and exact action/invocation mappings.
5. Run actual browser checks for editing, mobile/keyboard, nested errors, source/build parity, literal content, and bounded inspection.

Acceptance: no generation or execution API exists in the UI; existing observation UI remains useful; graph overlays invent no edges.
