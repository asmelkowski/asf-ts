# Portable workflows

The visual editor authors and validates YAML/JSON. The CLI/library performs all file generation and execution. Both use `asf-ts-workflow/v1`; Python ASF files need an explicit adaptation.

```sh
npm ci --ignore-scripts
npm run asf -- validate --file examples/portable/review.yaml
npm run asf -- compile --file examples/portable/review.yaml --output /tmp/review.mts
npm run asf -- render --file examples/portable/review.yaml --output /tmp/review.svg
npm run asf -- bundle --file examples/portable/review.yaml --output /tmp/review.asfb
npm run asf -- verify-bundle --file /tmp/review.asfb
npm run asf -- run-file --file examples/portable/review.yaml --run portable-demo --input '{"ok":true}'
npm run asf -- resume-file --file examples/portable/review.yaml --run portable-demo --input '{"ok":true}'
npm run asf -- run --workflow /tmp/review.mts --run generated-demo --input '{"ok":true}'
npm run asf -- serve --port 8080
```

Artifacts never overwrite files. `serve` creates an empty store if needed, then opens it read-only. Open `/studio` for authoring, `/graph` for declared graphs and exact receipts, and `/` for recorded execution lanes. The browser has no compile/run/resume/retry/file-path operation.

## Studio authoring

All three pages use a dark theme by default. Studio separates the definition and block library, declared canvas, and selected-block properties. Block kinds have names, icons and distinct shapes. Expand **Manage definitions** to change the root or add a child. Expand **YAML / JSON source** for direct source editing.

Select a block, choose **Insert after**, and add a block from the library. A branch offers **true** and **false** connections. Auto selects an available outcome; the inserted block retains the connection's existing successor. Sibling outcomes appear in the same downstream stage. Adding before a selected end retains the existing incoming-edge behavior.

Drag a block to move it. Focus a block with Tab, then use arrow keys for 20-unit movement or Shift+arrow for 60 units. The four direction buttons move the selected block. Drag empty canvas space to pan; use **+**, **−** and **Fit view** to zoom. View changes do not edit the document. **Arrange blocks** deliberately replaces manual positions using the declared connections. Escape cancels a movement preview.

Validate before download. Unapplied source and invalid property drafts keep download disabled. Movement changes layout only; YAML/JSON downloads retain positions and preserve semantic workflow identity. See the [modernization design](designs/studio-modernization.md) and [acceptance record](evidence/studio-modernization.md).

## Personas and marketplace catalogues

Open **Manage personas** in Studio. Create a named persona and set **System instructions**, instruction delivery, model, tools, mode, timeout and session intent. Choose it in **Workflow default profile** or **Node profile**. The underlying `profiles` map remains portable. **Advanced persona JSON** retains direct editing.

An omitted tool selection inherits the local binding. An explicit empty selection means no requested tools; strict selection also requires the target to enforce the exact inventory. Native system delivery requires the binding to configure the exact instructions. Child workflows retain their own default.

Connect a normalized catalogue through **Connect marketplace catalogue**, or start Studio with one:

```sh
npm run asf -- serve --port 8080 --persona-catalog examples/personas/catalogue.json
```

The sample contains synthetic model, tool and plugin names. Suggestions do not establish local support. A catalogue remains local discovery data; the workflow file stores only selected profile intent.

Normalize a reviewed local Claude-compatible marketplace manifest. Use the exact Git revision of the repository that contains the index and its relative plugin sources:

```sh
npm run asf -- import-marketplace --file /path/to/marketplace.json --revision EXACT_40_CHARACTER_GIT_SHA --output /tmp/persona-catalogue.json
```

For an explicit metadata fetch, replace `--file` with `--source https://raw.githubusercontent.com/OWNER/REPO/EXACT_40_CHARACTER_GIT_SHA/.claude-plugin/marketplace.json`. The importer reads one bounded index and creates a new output file. It does not read plugin code. External Git sources need their own exact `sha`; optional versions and floating sources remain discovery entries.

Select pinned entries in the persona form. Imported requirements that are absent from the current catalogue remain visible. Plugin selections are exact `{id, revision}` requirements. A trusted local binding must activate the matching plugins and declare the complete `capabilities.activePlugins` inventory. ASF rejects unknown inventory or any missing, extra or changed plugin before dispatch. An omitted plugin list keeps existing behavior; explicit `[]` requires a known empty inventory.

See the [persona design](designs/persona-workbench.md) and [marketplace decision](adr/0206-marketplace-plugin-requirements.md).

## Recipient configuration

Legacy JSON `--config` supports the current Codex/OpenCode constructors. Profiles select those named agents with conservative capabilities. Strict tools or native instructions need a preconfigured trusted binding. Use `--targets local-targets.ts` for bindings, including ADK; the module exports `bindings: Record<string, ProfileBinding>`. Import the optional ADK adapter explicitly from `src/adapters/adk.ts`; the core does not initialize it.

Custom nodes require `--registration local-components.ts`, exporting `components: Record<string, Component>`. Each component declares schemas, code/dependency identity and whether it is safe for concurrent read-only execution. These are trusted local modules and may execute host code when imported. Parsing, rendering, bundling, and UI validation never import them. Compiler flags freeze entry hashes; recipients provide their own reviewed local bindings. Bundles omit targets, prices, credentials and private native sessions.

```ts
await runtime.run((r) =>
  executeDocument(r, document, input, { bindings, components }),
);
```

Profiles resolve before any node dispatch. Workflow defaults belong to that workflow; child instructions are not inherited implicitly. Node selection and explicit caller overrides are recorded in execution identity. Agent nodes start fresh native sessions; compatible session policy permits use through the direct Runtime API with `checkContinuation`, but v1 files do not declare native session continuation edges.

## Semantics and limits

Schemas default to draft-07; explicit 2020-12 is supported. References select guaranteed input or earlier node data on every incoming path. Structural comparisons reject known contradictions and unsupported schema transformations; identical advanced schemas still validate their actual boundary values. Branch/end records are durable. Native failure, uncertain sends, cancelled commands and malformed typed values stop execution. Successful domain rejection remains data.

Repeat is finite. Its input is selected from the parent context for every iteration; stateful repair code must capture the new candidate explicitly. All/any parallel joins wait for all started children; failure cancels and drains siblings. Concurrent commands/writers/effectful components require isolation and are rejected in v1.

Source/closed document: 1 MiB; closure loader: 64 local files/4 MiB total; definitions: 64; nodes/definition: 128; schema: 16 KiB; repeats: 100; parallel branches: 16. Runtime inputs, prompts, raw receipts and outputs also have their documented core bounds. Child dispatch limits count ASF sends/corrections; native internal inference/tool loops require their own adapter bounds. Deadlines and quotas persist across resume.

Layout-only edits preserve semantic file execution identity. Generated drivers embed the source and use the same executor; the ordinary module CLI still binds the complete generated entry bytes and path. Regenerating that module with changed presentation bytes requires a new module run. Native full-workflow export is unsupported; a driver retains ASF durability and accounting.

Candidate approvals need `requireCurrent` after the outer workflow returns, including cached parent replay, and again at the consuming publication boundary. A historical receipt does not prove current Git bytes. No atomic merge or publication authorization is implied.

See [port design](designs/ts-port.md), [portable design](designs/portable-files.md), and [runtime design](designs/child-workflows.md).

## Offline ADK example

The [ADK document](../examples/portable/adk.yaml) and [local target binding](../examples/portable/adk-targets.ts) use the actual SDK with a deterministic local model and marker tool. They need no provider account or credential. The model reports tokens with an explicit fixture rate card. ADK remains write-only because it does not provide an operating-system read-only sandbox.

```sh
npm run asf -- validate --file examples/portable/adk.yaml
npm run asf -- run-file --file examples/portable/adk.yaml --targets examples/portable/adk-targets.ts --run adk-demo --input '{}'
npm run asf -- resume-file --file examples/portable/adk.yaml --targets examples/portable/adk-targets.ts --run adk-demo --input '{}'
npm run asf -- compile --file examples/portable/adk.yaml --targets examples/portable/adk-targets.ts --output /tmp/adk-demo.mts
npm run asf -- run --workflow /tmp/adk-demo.mts --run generated-adk-demo --input '{}'
```

The trusted example sends SDK diagnostics to stderr so CLI stdout remains JSON. Generated entry hashes bind this reviewed target file; dependency revisions remain the recipient's responsibility. See the [native export assessment](adr/0008-native-export-assessment.md).

Shared SVG renders include root and nested schemas, complete declared node contracts, profile intent, attempts and finite repeat/parallel rules. Rendering has a 4 MiB artifact bound; bundles keep the same member bound and an 8 MiB envelope bound. A valid source that exceeds artifact limits requires a smaller sharing view. Runtime bindings and native sessions remain absent.
The core library entry `src/index.ts` exports `CandidateVerifier`, typed child and profile contracts, portable file APIs, and `buildGraphInspection`. ADK stays an explicit optional adapter import. See [candidate verification](designs/candidate-verification.md) and [declared inspection](designs/declared-inspection.md).
