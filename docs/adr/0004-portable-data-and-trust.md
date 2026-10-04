# ADR 0004: Use one strict data model and explicit code trust

## Context

The editor, renderer, compiler, and executor must agree. Workflow files may come from other authors. Arbitrary native code cannot be reconstructed from data safely.

## Decision

Use YAML/JSON with inline workflow closure, named profiles, typed JSON references, declared transitions, and presentation-only layout. Load external local files through a bounded CLI closure loader. Reject duplicate keys, YAML aliases/tags, remote schema references, unknown fields, recursion, implicit cycles, and missing data on any incoming path. Freeze semantic closure and recipient bindings before execution. Custom components require explicit, identity-bound local registration. Generated TS drivers embed the source and call the same executor. Rendering and parsing never load executable registration code.

## Why

One validator prevents UI/CLI drift. Typed boundaries and bounded control make composition reviewable. Local registration preserves useful code without turning shared files into executable imports. Layout can change without invalidating receipts.
