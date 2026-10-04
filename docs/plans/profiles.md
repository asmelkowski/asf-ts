# Profile implementation plan

Designs: [profiles](../designs/profiles.md), [TS port](../designs/ts-port.md).
Ticket: #3. Decision: [ADR 0201](../adr/0201-profile-policy.md).

1. Parse intent with strict field and scalar checks. Freeze copied values.
2. Resolve explicit precedence against trusted local bindings.
3. Reject unsupported mode, freshness, tool inventory, strict selection, and native text.
4. Produce a frozen digest and local legacy config. Expose support in a safe preview.
5. Test parsing, precedence, mutation, channels, continuation, and actual Runtime projection.

Acceptance: unsupported requirements fail before dispatch; persona text is applied once;
secret values have no portable field; old accounting/session controls remain authoritative.
