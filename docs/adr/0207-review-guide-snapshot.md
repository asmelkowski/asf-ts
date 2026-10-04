# ADR 0207: Keep the review guide as a separate snapshot

## Context

PR 12 contains portable workflows, runtime changes, personas, target integration and web interfaces. A reviewer needs a route through the code. The user wants the guide in `asmelkowski/asf-ts` as a separate, unmerged PR. Upstream has only `main`; the current account cannot create an upstream integration branch.

## Decision

Create a documentation branch from upstream `main` and add only the guide files. Open a draft PR in `asmelkowski/asf-ts` and link it from product PR 12. Keep it open and unmerged. Pin the standalone HTML to the product's exact base and head. Embed source and diffs as inert data. Use local reviewer status and notes; require the same revision pair when importing notes. Keep recorded checks separate from reviewer approval.

## Why

The reviewer can inspect and share one file without starting ASF or loading remote dependencies. Exact pins preserve source and line references. A branch from `main` keeps the guide PR limited to documentation while the product integration stays separate. This target is available without changing repository permissions.
