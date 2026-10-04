# Studio implementation plan

Design sources: [Studio](../designs/studio.md), [profiles](../designs/profiles.md),
and [portable workflows](../designs/portable-files.md).

1. Add a separate editor route and a bounded same-origin validation endpoint.
   Reuse shared portable validation. Preserve inspection HTTP restrictions.
2. Add catalogue forms for all blocks, inline child contracts, profile intents,
   layout, and YAML/JSON source import. Use safe DOM and SVG text.
3. Keep invalid buffers visible. Gate downloads on the exact current revision.
   Reject stale responses and clean buffers when their block is deleted.
4. Verify HTTP bounds and absent execution routes with real server requests.
   Verify built assets and authoring, invalid drafts, round trips, keyboard,
   mobile layout, and inspector navigation in an actual browser.

Acceptance evidence belongs in [Studio evidence](../evidence/studio.md).
