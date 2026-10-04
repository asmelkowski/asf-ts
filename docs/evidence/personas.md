# Persona editor and marketplace acceptance

The persona workbench uses the existing portable profile library. See the [design](../designs/persona-workbench.md), [structured authoring decision](../adr/0205-structured-persona-authoring.md), [plugin decision](../adr/0206-marketplace-plugin-requirements.md) and [operating guide](../portable.md#personas-and-marketplace-catalogues).

## Reviewed scope

| Area         | Delivered behavior                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Persona form | Create, select, rename and confirm deletion; instructions/channel, model, tools, strict intent, mode, timeout and session      |
| Assignments  | Existing workflow defaults and agent-node overrides; atomic rename/removal; independent child defaults                         |
| Drafts       | Invalid fields survive selection; raw JSON/source guards, object ownership and stale-response checks remain authoritative      |
| Plugins      | Exact portable requirements; bounded searchable metadata; unavailable authored references retained and individually removable  |
| Marketplace  | Normalized local catalogue connection and explicit bounded Claude-compatible CLI metadata import                               |
| Execution    | Exact trusted active inventory before dispatch; unchanged omitted-field identities and existing native-instruction/tool checks |

The backend was independently reviewed and merged through [integration PR16](https://github.com/Kordikk/asf-ts/pull/16), reviewed head `f15e9429d0f8feb84252cea5629ffa3e645e9a7c`. Both [push CI](https://github.com/Kordikk/asf-ts/actions/runs/37206660433) and [PR CI](https://github.com/Kordikk/asf-ts/actions/runs/37206663728) passed before merge `a7dd2df3b350ca6c2e9d39ef5118b60833a89bc2`.

UI production pin: `11bfe69dc6b6952f691b6ccdfbabe54af29808c3`. Standards and Spec reviews cleared the production change and final import-guidance repair. Persona names use the existing 128-character profile limit; node IDs retain their 100-character limit. Review also repaired canonical URL and aggregate catalogue bounds. A real-browser regression reproduced stale empty-library guidance after importing a valid persona, then passed with the repair. Other messages and invalid drafts remain intact.

## Verification

- Full `npm run check` at `ebd5c52277a14798f1ee82b27dcece0d2d464e56`: 270 passing tests, zero failures and two existing opt-in native CLI skips. Type checking, lint, formatting and build passed. The final import-guidance repair adds a browser regression; [integration PR17](https://github.com/Kordikk/asf-ts/pull/17) tracks its reviewed final head and required CI.
- Actual built-server Chromium `141.0.7390.37` acceptance at `2026-10-04T14:25:05.806Z`, source/test pin `d9c9b33` with the production pin above, passed every previous Studio check plus persona controls, both assignment levels, 128-character names, literal `constructor`, actual YAML/JSON downloads, omitted/empty values, invalid drafts, raw replacements, both response races, newer-data retention, import guidance, 315-entry search, individual removal and keyboard/mobile controls.
- The browser report compares source, built and served assets. `persona-editor.js` SHA-256: `cdb41a7284f9a1b3a8926bcf271f8c3f363b883746e4eccfe22f509e42c93237`; `studio.js`: `2019bb103ab2a6e5537384b35921f24d414ecdaaad449ebf9826cb3d3624a8cf`; `studio.css`: `86d472264030290e82704151b553fba1bc8a69d7475e7655cec7da551ab94b74`. The local report retains the complete six-asset manifest.
- The original execution inspector browser gate passed. The declared graph gate passed at `2026-10-04T13:55:37.736Z`, including receipts, replay, uncertainty, literal source and keyboard/mobile behavior.
- The built CLI imported 315 metadata entries from the [official marketplace index](https://github.com/anthropics/claude-plugins-official/blob/d182ca456ca09d31d139f7d3818d1d333b103cce/.claude-plugin/marketplace.json) at exact revision `d182ca456ca09d31d139f7d3818d1d333b103cce`. It created a local catalogue; it fetched no plugin code.

Browser fixtures are synthetic and local. The authoring gate made no external requests and wrote no run/event rows. The explicit CLI marketplace fetch is separate. No paid provider calls, private native-session reads or executable plugin installations occurred.

## Operating limits

Catalogue selection records intent. The trusted local target must activate and qualify supported content, then declare its exact `activePlugins` inventory. Current built-in adapters report no such inventory by default. Unknown inventory rejects explicit plugin requirements, including `[]`. Omission retains existing behavior. This delivery does not add a universal native installer or cross-harness conversion.

Native system delivery and strict tools retain their existing exact preconfiguration requirements. Deleting an assigned persona removes those references; any agent left without a default or node selection must be reassigned before export. Catalogue connection is local browser discovery state; exported workflow files carry selected intent, not credentials, installers or the full catalogue.

Run `npm run build`, then `npx tsx scripts/verify-studio.ts`, `npx tsx scripts/verify-graph.ts` and `npm run verify:ui` for account-free browser acceptance. Ignored `.asf` artifacts contain the dated reports and screenshots; the original sensitive live qualification material is unrelated to this acceptance.
