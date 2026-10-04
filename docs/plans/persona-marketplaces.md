# Persona marketplace implementation plan

Design inputs: [persona workbench](../designs/persona-workbench.md) and [profiles](../designs/profiles.md).

1. Extend portable profile intent with bounded exact plugin references and trusted active inventories.
2. Preserve legacy identity; enforce exact requirements before dispatch and in continuation identity.
3. Add strict normalized catalogue data and a bounded Claude-compatible metadata adapter.
4. Add explicit CLI local/immutable-remote import with exclusive output.
5. Serve optional catalogue data without importing executable targets; allow browser file connection through same-origin validation.
6. Test unpinned/external sources, malformed payloads, literal metadata, bounds, no overwrite, old call signatures and no install/provider operations.

Acceptance: marketplace discovery and persona selection work through portable metadata; actual plugin activation remains explicit trusted local setup and must match requirements.
