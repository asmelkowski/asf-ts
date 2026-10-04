# ADR 0201: Resolve portable profiles against local bindings

## Context

Portable workflows need named personas. TS already binds native sessions, adapter policy,
and price provenance. Imported files cannot assert installed capabilities.

## Decision

Select the workflow default, then the node profile, then an explicit caller profile.
Merge default fields, named intent, and explicit caller fields in that order. Replace
instructions and tool arrays. Resolve against trusted local bindings. Require an exact
preconfigured inventory for strict tools and exact preconfigured native instructions.
Default to fresh sessions. Bind capability revision and adapter identity into a frozen digest.

## Why

Explicit caller precedence supports caller-owned policy in TS. It differs from Python's
node-first precedence and belongs to the distinct TS format. Local bindings preserve
accounting and actual target policy. A prompt prefix remains advisory.
