# Declared inspection acceptance

Observed on 2026-10-04 at production source revision
`cb6a7badd19774c3e8154237bd1c650271c8b93d`.
This revision includes the production HTTP integration at `b7e8e2b`.

## Checks

| Check                                   | Result                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Projection fixtures                     | 11 passed, including original v1 stores, exact child slots, corrupt source, concurrent commits and malformed accounting |
| Production graph HTTP routes            | 1 passed; bounded focus, GET/Host/Origin/fetch-site guards, byte parity and unchanged accounting totals                 |
| TypeScript and browser JavaScript types | Passed                                                                                                                  |
| ESLint, Prettier and diff checks        | Passed                                                                                                                  |
| Production build                        | Passed                                                                                                                  |
| Actual headless Chromium                | Passed with Chromium 141.0.7390.37 at 09:58:52 UTC                                                                      |

The browser starts the built CLI loopback server against real, ephemeral SQLite
runs. The runs use scripted native receipts and ordinary local callbacks. No live
provider, credentials or private native session files enter this check.

The walkthrough verifies authored edges, exact parent and child invocation links,
two correction receipt IDs and turn numbers, ledger subtotals without report
double counting, completed negative business results, actual root replay counts,
and retained partial cost after an uncertain native send. It checks independently
paged action/receipt windows with exact workflow focus, ordinary-run fallback,
unknown-run handling, literal source text, keyboard selection, and a 390-pixel
mobile viewport. Every browser request is a local GET. Inspection adds no events
and starts no new model calls.

## Reproduce

```sh
npm run build
npx tsx scripts/verify-graph.ts
```

The runner saves its report and screenshots under `.asf/graph-verification/`:

- `acceptance.json`
- `graph-nested-receipt.png`
- `graph-uncertain.png`
- `graph-partial-window.png`
- `graph-mobile.png`

The fixture database is removed after the run. The screenshots and report remain
local artifacts. This evidence covers the offline inspection path. It does not
qualify a paid provider, hostile-process sandbox, signed audit trail, or native
invoice completeness. Independent review and the final integration CI gate are
recorded separately by the delivery coordinator.
