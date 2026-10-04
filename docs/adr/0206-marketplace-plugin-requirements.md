# ADR 0206: Separate marketplace discovery from active plugins

## Context

The user wants marketplace plugins in personas. Plugin formats and activation differ across harnesses. A marketplace entry can contain commands, hooks or executable installation sources. A version string does not pin content.

## Decision

Import bounded catalogue metadata, including Claude-compatible marketplace indexes. Pin relative sources to the index's exact Git revision; external sources need their own immutable revision. Profiles select catalogue-qualified plugin IDs and exact revisions. Local target capabilities may report active plugins. An explicit persona plugin selection must exactly match that known active inventory before dispatch. Omitted selections retain existing behavior.

Connect catalogues from data files or an explicit CLI metadata fetch. Studio browses and selects metadata; it does not install plugins, import target code or fetch marketplace URLs. Keep unpinned and unavailable entries visible with their status. Unknown active inventory rejects requested plugins. No generic cross-harness execution compatibility is claimed.

## Why

Portable selections can be shared and validated without carrying credentials or trusting install instructions. Exact inventory matching prevents a selected subset from hiding additional active plugin effects. The existing trusted-binding seam remains responsible for real activation. The [Claude marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) distinguishes marketplace metadata from plugin installation and manifest composition.
