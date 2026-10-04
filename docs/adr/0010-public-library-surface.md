# ADR 0010: Expose reusable contracts through the core entry

## Context

Composition, profiles, portable files, candidate verification and declared inspection are separate modules. Library consumers need one stable entry for these contracts, with optional native SDK initialization under their control.

## Decision

Export the reusable contracts and functions from `src/index.ts`. Keep ADK behind an explicit `src/adapters/adk.ts` import. Core imports remain inert: no provider initialization, store creation, snapshot capture, or UI asset read. Studio continues to use the data validator directly.

## Why

Consumers can compose one set of typed contracts without depending on private module paths. The optional SDK and browser data boundary remain explicit. Existing cold-import and CLI-help tests verify the entry works when UI assets are unavailable.
