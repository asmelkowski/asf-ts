# Named profiles

Tickets: #3. Parent design: [TS port](ts-port.md).
Decision: [ADR 0201](../adr/0201-profile-policy.md).

`parseProfile` and `parseProfiles` accept portable intent and reject unknown fields.
Intent contains instructions, instruction channel, model, mode, tools, strict selection,
timeout, and session policy. Local paths, prices, credentials, and capability claims have
no portable fields. Instructions are visible content, not secret storage.

`resolveProfile` accepts named profiles, local bindings, workflow and node selection, and
explicit caller overrides. It validates fragments before merging and checks the complete
intent afterward. A strict override can inherit the selected tools. It returns a frozen
`ResolvedProfile`. The preview contains
visible intent and actual instruction/tool support. Its digest includes adapter identity,
which already binds protocol and price provenance. Model changes still pass native
preflight; profiles do not invent rates or relax mandatory accounting.

Native instructions require the exact text in a preconfigured native binding. The legacy
agent config then omits the prompt prefix. Strict tools require an enforced exact inventory;
an empty array means no tools. Advisory tools require a known inventory and add visible
guidance to a prompt prefix. No tool policy claims operating-system containment.

Fresh profiles cannot continue sessions. Compatible profiles require the same digest.
The dispatch caller must persist the digest before dispatch and enforce that check before
passing a session. Child definitions resolve their own defaults; a parent does not append
its persona or transcript. Existing ordinary `AgentConfig` callers keep their behavior.

See the [implementation plan](../plans/profiles.md).
