# Studio modernization acceptance

Delivery date: 4 October 2026. [Upstream issue 13](https://github.com/asmelkowski/asf-ts/issues/13) records the user's five UI observations. The [design](../designs/studio-modernization.md) uses both the [visual workbench](../plans/studio-visual-workbench.md) and [direct canvas](../plans/studio-direct-canvas.md) plans. [ADR 0203](../adr/0203-dark-workflow-workbench.md) and [ADR 0204](../adr/0204-direct-canvas-layout.md) record the theme and interaction decisions.

Production assets under review: `6907f4cba8cb871d2e4a20cd0255c755557351f5`. Independent Standards and Spec reviews cleared the theme and workbench. Review found an icon/frame selector overlap; the final assets scope frame styling and preserve outlined glyphs. A browser regression covers that repair. Final review also repaired literal object-key layout IDs and retained same-ID rename coordinates; action and browser regressions cover both supported literal keys.

| User observation                  | Accepted behavior                                                                                                | Evidence                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default dark mode                 | Studio, original inspector and declared graph remain dark with a light browser preference                        | Actual Chromium reads computed dark surfaces, default text contrast and dark native controls on all three pages                                       |
| Weak hierarchy and uniform blocks | Separate library/canvas/properties, stronger titles, kind names, icons, shapes, labelled ports and visible focus | Desktop screenshots, computed typography and keyboard focus checks                                                                                    |
| Second parallel outcome misplaced | Auto and explicit true/false insertion preserve each successor; sibling blocks share the next stage              | Actual control interactions plus focused topology/collision regressions                                                                               |
| Numeric-only movement             | Drag, pan, zoom, fit, arrow keys and direction buttons                                                           | Real pointer movement under scroll/zoom/pan and negative imported positions; cancellation restores layout                                             |
| Confusing workbench               | Compact document actions and properties; definition management and advanced source are collapsed                 | All prior forms and draft/race/download checks remain; 390-pixel mobile has no page overflow; usable first palette icon/title/44px target at 1265×712 |

The complete local `npm run check` passed at test head `8893156c443e7ecb877dfd50612c178cf22b911f`, with production assets unchanged from `6907f4cba8cb871d2e4a20cd0255c755557351f5`: **250 passing tests, zero failures and two opt-in native-CLI skips**, plus typecheck, lint, formatting and build. The eight focused Studio action regressions cover geometry, topology, drafts, cancellation and both literal IDs. Linux CI must pass the complete final PR head before merge.

Actual Studio Chromium acceptance ran at `2026-10-04T12:36:11.150Z`, browser `141.0.7390.37`, against built and served assets identical to production pin `6907f4cba8cb871d2e4a20cd0255c755557351f5`. The report records five SHA-256 asset hashes; final `studio.css` is `cb4152d4b6028c173aee04be919cf0ea995ec84f166aa75f38525a721ca4e651`. Literal `__proto__` and `constructor` IDs also passed real form rename, movement, validation and JSON download/reimport with own coordinates and stable identity. Checks include moving an implicitly positioned imported block without shifting its neighbours, stale preview cancellation, invalid node/profile/source ownership, and actual dragged-layout YAML/JSON download/reimport with unchanged semantic identity.

The original inspector and declared graph browser suites also passed against the final shared theme. The declared graph report is dated `2026-10-04T12:11:52.462Z`. No runtime or inspection JavaScript changed in this UI follow-up. Fixtures are synthetic or ephemeral stores; checks make no paid provider requests, read no private native sessions and write no workflow run/event rows through Studio.

Reproduce from the repository root:

```sh
npm run check
npx tsx scripts/verify-studio.ts
npm run verify:ui -- --quick
npx tsx scripts/verify-graph.ts
```

Ignored browser artifacts are in `.asf/studio-verification/`, `.asf/ui-verification/` and `.asf/graph-verification/`. This is focused keyboard, contrast, mobile and dragging evidence, not a full accessibility certification. Numeric positions remain available for exact edits. Generation and execution remain in the CLI/library.

The [dark inspector theme PR 14](https://github.com/Kordikk/asf-ts/pull/14) merged before the Studio workbench follow-up. Theme head `82c01fb21ab79e52d0c534bb1ebd2518a9d9630c` passed both [push](https://github.com/Kordikk/asf-ts/actions/runs/37201764436) and [PR](https://github.com/Kordikk/asf-ts/actions/runs/37201794523) Linux gates before merge; its aggregate gate also passed at `b682dbeb31521f3f8642ea0bc8a40e1abeb6579b`. The workbench must pass its complete final-head gates before merge. The upstream integration [PR 12](https://github.com/asmelkowski/asf-ts/pull/12) remains the final delivery entry point.
