# ADR 0002: Adapt Python contracts to the TS runtime

## Context

Python PR #21 adds portable authoring. ASF-TS already owns native sessions, immutable accounting, and a bounded inspection UI. The user permits TS behavior changes and requests file processing outside the UI. The historical AGENTS restrictions prohibit graphs and publication and refer to unavailable `/root` paths.

## Decision

Treat the user's current authorization as the governing scope. Keep the existing native reservation, receipt, ledger, session, command, and inspection contracts. Add optional `asf-ts-workflow/v1` documents and a lowering executor. Keep ordinary async TS workflows. Add authoring as a separate mode. Compile, run, render, and bundle only through the CLI/library. Adapt useful Python concepts; do not copy the Python implementation or declare file compatibility.

## Why

A direct transplant would lose stronger TS accounting and session checks. A separate version prevents false compatibility claims. The browser stays an account-free document editor. Existing supervised improvement and provider inspection remain available.
