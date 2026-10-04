# ADR 0009: Control persisted time in deadline regression tests

## Context

A Linux CI run reached the intended blocked preflight after its 70 ms fixture deadline had already expired. Host scheduling changed the first failure and obscured the persistence behavior under test.

## Decision

Use Node's test clock for the two persisted-deadline fixtures. Give initial execution a 30-second window, then advance Date beyond the bound at the intended boundary: after blocked preflight, or inside an already reserved native invocation. Keep real process timeout, cancellation and drain tests separate. Change no production timeout behavior.

## Why

The tests now prove unchanged deadlines on resume and retained accounting after late completion without relying on host speed. Actual timer cancellation and process cleanup still have their own integration coverage.
