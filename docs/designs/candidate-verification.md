# Candidate verification

## Contract

`CandidateVerifier` exposes a reusable `WorkflowDefinition`. It checks an existing candidate; it does not write an implementation. The same child runs alone or inside delivery and existing-PR parents. `examples/candidate-verification.ts` provides all three paths.

The trusted caller supplies a repository, base commit, revision, 1–8 fixed argv checks, and a read-only reviewer config. The constructor resolves the base once and binds the effective checks, reviewer settings, native harness identity, and helper bytes into its identity. Commands and reviewer dispatch use the existing runtime reservation, receipt, cancellation, and accounting paths.

The result contains the candidate descriptor, contract identity, check evidence, and typed review. `approved`, `changes_requested`, and `unavailable` are valid business results. Only approval sets `passed: true`. A normal nonzero check exit means changes requested. A missing check executable means unavailable. Cancellation, signals, malformed output, native failure, and integrity failure throw. They do not become rejection or approval.

## Candidate boundary

Capture runs inside a reserved `Scope.local` action. It hashes tracked and nonignored untracked files, missing tracked paths, file modes, index content and flags, HEAD, and the resolved base. It retains a bounded baseline-relative whole-file patch. The patch includes additions, deletions, executable changes, and symlink target text. Binary changes use exact hashes; the reviewer can inspect the frozen file.

The ignored `.asf/verification/<identity>` artifact holds the manifest and source copy. Files are read-only; executable files remain executable. Symlinks become regular text files. Verification compares the copy with the original inventory, rather than trusting a modified snapshot manifest.

Limits are 5,000 paths, 16 MiB per file, 32 MiB of current source, 256 KiB of identity metadata, and 16 KiB of serialized patch text. The total source bound is independent of the per-file limit. Retained binary assets can enter the frozen copy within these bounds; patch text represents them with exact hashes. Private paths, submodules, unmerged indexes, unsafe path ancestors, and unsupported file types fail before review. Oversized candidates need a different explicit boundary. Ignored files are outside this boundary.

## Check and review execution

The host launches a fixed helper through `Scope.command`. The helper runs the configured argv without a shell, with the frozen source as cwd. It clears inherited Git repository selectors and blocks ancestor Git discovery. The copy contains no Git repository; a Git-aware check must report unavailable or fail. Runtime owns its process group, timeout, durable command receipt, and cancellation. The helper retains 4 KiB per output stream, plus real exit, signal, availability, and truncation evidence. Full check logs are not claimed.

The reviewer wrapper binds the candidate, effective cwd, and complete review contract into the harness identity. It sends no prior native session and performs no JSON correction. A native harness must support read-only mode. The current ADK proof advertises write mode only and cannot serve as this reviewer.

Both original source and frozen copy are checked before and after every check and reviewer. A retained failed or malformed native receipt is never resent. A completed child replays its report without new commands or model calls.

## Consumption and compatibility

Call `requireCurrent(report)` after the outermost workflow returns, before accepting the report. This check must sit outside a cached parent. It validates report shape and evidence consistency, current bindings and helper bytes, and both source inventories. A stale report requires a new explicit parent attempt and candidate capture.

The existing self-improvement workflow keeps its writer, repair, formatting, scope, baseline, and session behavior. It reuses only the shared bounded check-evidence projection. No existing SQLite records are rewritten.

The caller, check code, and harness are trusted. This module does not sandbox hostile processes, audit ignored writes, recover external native state, sign reports, apply patches, or merge code. A process that escapes its group remains outside runtime cleanup. This run uses account-free deterministic fixtures only.
