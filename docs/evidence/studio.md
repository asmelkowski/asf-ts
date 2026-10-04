# Studio acceptance evidence

This evidence covers account-free authoring. It does not qualify hosted providers
or native target behavior. The distinct TS format is `asf-ts-workflow/v1`.

Run the checks from the repository root:

```sh
npm run build
npx tsx scripts/verify-studio.ts
npx tsx --test test/studio-http.test.ts test/http.test.ts test/ui-http.test.ts test/portable.test.ts test/profiles.test.ts
```

The browser runner creates a new empty database under ignored
`.asf/studio-verification/`. It starts the built CLI server. It uses the pinned
Playwright Chromium when installed, `ASF_STUDIO_BROWSER` when selected, or installed
macOS Chrome as a fallback. It records the actual browser version in
`acceptance.json` and saves desktop and mobile screenshots. It does not read user
credentials, native sessions, or existing databases.

| Boundary        | Observed acceptance                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Served assets   | Source, built, and HTTP bytes match for Studio HTML, JS, CSS, and shared CSS                                                                                |
| Forms           | All eight block kinds are created through controls; typed child schemas, zero child dispatch allowance, compound limits, transitions, and profiles validate |
| Child isolation | A root profile does not add a child default; child contracts remain visible                                                                                 |
| Layout          | Negative coordinates remain visible; coordinate edits and arrangement keep semantic identity                                                                |
| Invalid drafts  | Invalid node JSON and profile JSON stay visible and disable download; canonical profiles do not partially change                                            |
| Response race   | An older successful response cannot approve a newer field edit                                                                                              |
| File handling   | Actual JSON and YAML downloads reimport with the same identity; duplicate-key YAML stays visible and rejected                                               |
| Cleanup         | Deleting an invalid block removes its pending buffers; repairing Start permits validation                                                                   |
| Browser use     | Keyboard selection and 390 px layout work; the original inspector link remains available                                                                    |
| Privacy         | Imported HTML remains text; no external requests occur; only validation POSTs occur; run and event tables stay empty                                        |
| HTTP            | Foreign Origin, foreign Host, cross-site requests, wrong content types, extra payload fields, and bodies over 1 MiB reject                                  |

The local run on 4 October 2026 used Node 22.22.3 and installed Chrome 154.0.8037.95.
All 25 focused server, portable, profile, and legacy HTTP tests passed.
After integration with portable execution, composition, and ADK, `npm run check`
passed 207 tests and skipped two opt-in lifecycle tests. Type checks, lint,
repository formatting, and the build passed. The browser runner also passed on
the merged source, including a child with zero dispatch allowance.
The browser runner passed against built assets. Root integration still runs the
complete offline suite and independent reviews on the merged commit.

See [Studio design](../designs/studio.md) and
[implementation plan](../plans/studio.md).
