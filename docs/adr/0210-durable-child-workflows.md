# ADR 0210: Bind child workflows inside one run

## Context

Reusable child workflows need typed results, replay, and an exact relationship to their caller. A second Runtime or Store would create separate ownership and budget boundaries.

## Decision

Add `Runtime.workflow` and `Scope.workflow`. Bind the versioned code identity, schemas, selected JSON input, parent invocation, attempt, and normalized limits before execution. Freeze selected data. Reserve a namespace per invocation. Retain raw output before validation, then commit the typed business verdict and provenance. Completed results replay after schema validation. Known failures require a caller-owned new attempt; unsent preflight gates can resume the same attempt. Reject recursion and scope use after completion.

## Why

The child API hides storage and native lifecycle rules. One root owner preserves session exclusion and immutable accounting. Explicit attempts permit repair without silently repeating an uncertain native send.
