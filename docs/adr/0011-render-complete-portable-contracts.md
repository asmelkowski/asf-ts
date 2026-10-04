# ADR 0011: Include contracts in shared workflow renders

## Context

Topology and profile names do not explain typed boundaries or execution bounds. Issue #7 requires a shared render to expose nested interfaces, profile intent and finite compound rules.

## Decision

Render escaped workflow input/output schemas and each complete declared node contract. Include shared profile intent once, then refer to selected names. Label branch ports, child attempts, repeat bounds and parallel joins. Keep rendering in the CLI/library. Bound the SVG to 4 MiB; bundle validation retains member and envelope bounds.

## Why

Recipients can inspect the full declared contract without a provider account, executable binding or web UI. Shared profiles are not expanded at every reference. Detailed metadata avoids dropping semantics from compact graph labels. Rendering does not change workflow execution identity or claim native support.
