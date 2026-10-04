# ADR 0220: Inspect declared graphs through verified stored relationships

## Context

A scope-lane observation map cannot reconstruct an authored workflow graph. Native receipts, workflow rows, source documents, and actions also have independent bounded windows.

## Decision

Add a separate read-only graph projection. Verify the authored snapshot digest, schema validity, definition metadata hash, version, and boundary schemas. Map actions only through their persisted workflow owner, exact namespace, and declared action kind. Map child calls through recorded parents, declared workflow names, attempts, iterations, and branch IDs. Keep lifecycle state separate from completed business verdicts. Expose actual replay-event counts and loaded ledger subtotals without adding reports. Keep one exact focused workflow visible while native record windows change. Reject inconsistent reads after three bounded retries using SQLite data_version.

## Why

The view presents source and receipt evidence without inventing causal edges or skipped states. Exact focused lookup preserves bounded paging. The legacy inspector and native session boundary remain intact.
