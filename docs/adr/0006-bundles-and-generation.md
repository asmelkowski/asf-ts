# ADR 0006: Use a JSON bundle and one ASF driver generator

## Context

Shared workflows must remain inspectable without provider accounts. Python uses a ZIP bundle and an optional native-export experiment. TS has a strong existing durable runtime.

## Decision

Package source and SVG in a deterministic bounded JSON envelope with byte hashes and a support report. Generate TypeScript drivers that embed the closure and call the portable executor. Reject unsupported native export explicitly. Evaluate a separate stateless ADK subset only after its SDK proof; full lifecycle export is a no-go for this delivery.

## Why

The JSON envelope needs no archive extraction and works with ordinary tools. One execution path prevents drift between direct and generated behavior. A native graph does not preserve ASF reservations, immutable accounting, child ancestry, or uncertain-send semantics by itself.
