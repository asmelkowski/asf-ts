# Direct canvas implementation plan

Design inputs: [Studio modernization](../designs/studio-modernization.md) and [original Studio](../designs/studio.md).

1. Add explicit insertion ports and place a new block beside its selected connection.
2. Preserve the port's former successor and avoid overlap with existing positions.
3. Add pointer drag with stable capture, temporary geometry, coordinate conversion and cancel rollback.
4. Add zoom, fit and pan controls plus keyboard and direction-button movement.
5. Preserve pending drafts, source ownership, validation races and export guards.
6. Browser-test two parallel branch outcomes, negative/scrolled/zoomed movement, cancellation and YAML/JSON layout round trips.

Acceptance: direct movement changes presentation only; both branch outcomes stay connected and visually adjacent; invalid drafts cannot be exported.
