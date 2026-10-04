# ADR 0122: Check candidate freshness at consumption

## Context

A completed parent workflow returns its cached result. Its child code does not run again. Approval can therefore outlive the source bytes that a reviewer checked.

## Decision

Bind each report to a candidate and verification contract. Require the consumer to call `CandidateVerifier.requireCurrent()` after the parent returns, including completed replay. Check the original source, index, HEAD, frozen copy, check contracts, reviewer binding, and helper protocol.

## Why

The outer check closes the cached-parent gap without repeating checks or sending another reviewer. A changed candidate needs a new explicit attempt. Approval remains a business result; it does not authorize publication or merge.
