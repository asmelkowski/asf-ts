# ADR 0211: Reserve logical turns against every ancestor

## Context

Parallel children and structured corrections can exceed a parent allowance if each child checks its own counter. Restarting a child can also renew a relative timeout.

## Decision

In the native reservation transaction, reserve one logical ASF model dispatch against every persisted ancestor. Include offline harness fixtures and correction turns. Keep existing paid dispatch and soft cost budgets. Store a deadline once, bounded by the parent deadline. Propagate AbortSignal through child and parallel scopes. A thrown parallel failure cancels siblings and drains them; a negative business verdict remains data. Child aggregates drain started durable descendants before completion.

## Why

A single transaction prevents quota races. Replay consumes no new reservation. Persisted deadlines prevent timeout renewal. Logical ASF dispatches do not claim to count native model loops, tools, hidden provider retries, or hard invoice costs. Trusted callbacks that ignore cancellation require process isolation for forced termination.
