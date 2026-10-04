# Portable file contract

Design input: [TS port](ts-port.md). Plan: [portable files](../plans/portable-files.md). Tickets: #5–#7.

`asf-ts-workflow/v1` uses a root name, a closed map of definitions, optional profiles, and layout. A definition has a version, input/output schemas, start ID, and nodes. Local file imports are a CLI convenience; exported documents contain the full inline closure. The editor never resolves server paths.

| Node     | Result and transition                                              |
| -------- | ------------------------------------------------------------------ |
| Agent    | Typed native result; one next ID                                   |
| Command  | Exit/output data; cancellation stops execution                     |
| Workflow | Typed child value; business verdict stays in its receipt           |
| Custom   | Declared schemas and explicit trusted local registration           |
| Branch   | Typed predicate; exactly one declared route                        |
| End      | Typed value and boolean business verdict                           |
| Repeat   | Finite child calls; value, iteration count, and exhaustion verdict |
| Parallel | Read-only children; all/any verdict after complete drain           |

Data selection uses an exact object such as `{$ref: '#/nodes/check/code'}`. Input references use `#/input`; repeat predicates can select `#/result`. Required-property and incoming-path checks reject unavailable data. Runtime schema validation covers values at agent, custom, child, and end boundaries without coercion. Structural cycles require an explicit repeat bound. Schemas do not load remote references.

The compiler emits a readable TypeScript driver with embedded source and identity. The driver calls the same executor as file execution. Recipient target bindings stay local. A custom registration module is explicit trusted code; the compiler freezes its entry bytes, and components declare their own dependency revision. Arbitrary transitive module hashing is not claimed.

Rendering contains declared edges only. A bundle is a deterministic bounded JSON envelope containing canonical source, SVG, SHA-256 member hashes, semantic identity, and support report. Validation verifies members without filesystem extraction. This format avoids a ZIP parser and permits ordinary JSON tools to inspect it. Recipients must still review trusted commands/components before execution.
