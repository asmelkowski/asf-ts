# ADR 0003: Aggregate reviewed PRs in a fork

## Context

The signed-in account `Kordikk` can read upstream ASF-TS but cannot push. The user requests an integration branch and smaller self-reviewed, self-merged PRs.

## Decision

Create `Kordikk/asf-ts:integration/portable-workflows`. Publish adapted issues upstream. Merge feature PRs into the fork's integration branch after offline checks and independent reviews. Open one final cross-fork PR against `asmelkowski/asf-ts:main`. Leave that final PR open for the maintainer.

## Why

This preserves the requested review history with available permissions. It requires no global GitHub/auth changes and does not merge upstream without write access.
