# ADR 0121: Account for ADK calls at the model seam

## Context

ADK may discard uncommitted response events after cancellation. One native invocation may make several model calls. Streaming usage snapshots are not distinct calls.

## Decision

Wrap the official BaseLlm instance. Retain the last usage snapshot for each call and sum distinct calls. Report cumulative totals to the existing mandatory sink. Use only explicit matching local prices and reported text-token fields. Retain known subtotals while missing usage, model reroutes, invalid usage, interruption, and cleanup errors remain incomplete. A cancelled or failed operation cannot become a successful business result. Use both ADK's finite `maxLlmCalls` and a wrapper limit before each underlying call.

## Why

Response tracing cannot serve as the accounting ledger. The wrapper captures native call evidence before event filtering. ASF's `maxDispatches` and logical workflow-turn limits count outer ASF invocations; they do not measure provider retries or native internal calls. Scoped estimates do not claim invoice completeness.
