# ADR 0123: Review a frozen source copy

## Context

A check or reviewer can change source. Existing native sessions can also contain stale context. A reusable verification workflow needs one clear candidate boundary.

## Decision

Copy bounded public source into an ignored artifact directory. Limit files to 16 MiB and total source to an independent 32 MiB. Make files and directories read-only. Represent symlinks as regular files that contain their target text. Run fixed argv checks and a fresh read-only reviewer in this copy. Compare both the original candidate and the copy before and after each action.

## Why

Checks and review use the same bytes. The file bound includes existing retained binary assets without increasing the total bound. Content, mode, index, and HEAD changes invalidate the report. Symlink targets outside the repository are never read. File permissions and comparison are integrity checks, not an operating-system sandbox.
