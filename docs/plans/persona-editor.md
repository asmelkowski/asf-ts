# Persona editor implementation plan

Design inputs: [persona workbench](../designs/persona-workbench.md), [profiles](../designs/profiles.md) and [Studio](../designs/studio.md).

1. Add a dedicated structured editor backed by the existing profile map.
2. Reuse Studio draft, source ownership, revision and validation controls.
3. Add atomic create/rename/delete with workflow and agent-node assignment updates.
4. Preserve omitted/empty fields and unavailable imported plugin references.
5. Add catalogue model/tool suggestions and pinned plugin selections.
6. Verify real browser field editing, assignments, invalid drafts, imports/downloads, keyboard and mobile behavior.

Acceptance: authors configure personas through fields; existing advanced JSON and workflow/node selections remain usable; no execution path is added to Studio.
