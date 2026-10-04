# ADR 0008: Keep one execution engine for generated workflows

## Context

[TS issue #11](https://github.com/asmelkowski/asf-ts/issues/11) ports the Python native-export assessment. Python pins `google-adk` 2.11.0 and includes an experimental stateless branch/end exporter. This TS port pins the separate `@google/adk` 2.2.0 package. Package versions and lifecycle protocols are not interchangeable.

| Contract            | Python reference                                | TS delivery                                                                                   |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Native model seam   | Python async SDK component                      | `BaseLlm` wrapper, actual `Runner`, synchronous ASF reports                                   |
| Native graphs       | SDK components plus stateless export experiment | Reviewed fixed `BaseAgent` or native `Workflow` inside one Harness invocation                 |
| Native continuation | Fresh component invocations                     | Owned in-memory continuation; completed ASF receipt replay; no restored unfinished checkpoint |
| Cancellation        | Async component checks                          | `AbortSignal`, model/event bounds, late-success rejection; effects are not rolled back        |
| Durable controls    | ASF dispatcher and child receipts               | Existing TS SQLite reservations, immutable accounting, session ownership and ancestor limits  |
| Export proof        | Pure branch/end input/output equivalence only   | Outside-UI generated ASF TypeScript driver, same direct executor                              |

See the [Python assessment](https://github.com/asmelkowski/asf/blob/5f6cd638cd7134b2e959861eb2ae2849fd30a181/docs/design/adk-native-export.md), [TS adapter design](../designs/adk.md), and [portable design](../designs/portable-files.md). The SDK tests exercise the installed package; they do not prove paid provider behavior.

## Decision

Do not add native graph export in this delivery. Generate an ASF TypeScript driver for every supported portable node. Report native export as unsupported. Keep ADK agent and fixed graph execution behind the existing Harness interface. Defer other frameworks and arbitrary native reverse import.

## Why

A pure branch/end native subset would exclude the confirmed product needs: typed children, profiles, verification, bounded repetition and joins with durable replay. It would create another compiler and conformance matrix without a confirmed native-only hosting need. A full exporter would also need independent durable reservation, accounting, quotas, session ownership, cancellation and crash-recovery implementations. The generated ASF driver already preserves these contracts through one execution path. Revisit native export when a concrete hosting requirement and supported lifecycle subset justify that maintenance cost.
