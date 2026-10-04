# Candidate verification implementation plan

Source design: [Candidate verification](../designs/candidate-verification.md). Decisions: ADR 0122 and ADR 0123.

1. Add bounded candidate inventory, baseline-relative patch, frozen copy, and strict integrity checks. Keep capture inside a durable local reservation.
2. Add fixed check execution through the existing command path. Retain exit, signal, availability, output, and truncation evidence.
3. Add a fresh read-only reviewer wrapper. Bind its effective cwd and candidate to native session identity. Preserve native failure and accounting behavior.
4. Expose the child definition and an outer `requireCurrent` consumption guard. Add standalone, delivery, and existing-PR examples.
5. Test replay without another send, stale approval after cached-parent replay, tampered snapshots, altered original source/index/HEAD, negative and unavailable results, and transport failures.
6. Share the existing check-evidence projection with self-improvement. Run its regressions and the full repository checks.

Acceptance requires one retained receipt per action, no implicit retry, both parent examples, and an explicit freshness check after cached parents return. Live provider qualification and automatic publication remain outside scope.
