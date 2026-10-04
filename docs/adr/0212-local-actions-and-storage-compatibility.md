# ADR 0212: Reserve local effects and extend SQLite v1 additively

## Context

Portable branches and trusted local components need durable receipts. A callback may perform an effect before its process fails. Existing stores already protect native receipts, reports, and ledger rows.

## Decision

Add `Runtime.local` and `Scope.local`. Reserve before calling local code. Store JSON output and scoped zero ASF model accounting before returning it for caller validation. Replay a retained receipt; never repeat a reservation without one. Add workflow, source document, action owner, and ancestor usage tables without changing SQLite `user_version=1` or old tables. Read-only original stores return an empty composition view. Keep existing inspection and ordinary runtime event behavior. Page the new composition view with explicit counts and a maximum of 200 rows per collection.

## Why

The local API gives pure nodes and trusted effects the same conservative crash boundary. Zero ASF model usage excludes host effects and external service charges. Additive tables preserve old ledger, session, budget, action, and event bytes. The old binary can read its old tables; it cannot execute new composition APIs or enforce their limits.
