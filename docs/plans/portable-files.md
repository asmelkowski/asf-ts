# Portable files implementation plan

Design inputs: [TS port](../designs/ts-port.md), runtime and profile designs. Tickets: #5, #6, #7, #11.

1. Publish strict TS types, safe YAML/JSON parsing, shared validation, and semantic identity.
2. Validate schemas, typed references, all incoming paths, child closure, finite repeats, and joins.
3. Lower validated nodes through child, agent, command, and local receipt APIs.
4. Add file-driven CLI validate, compile, run, render, and bundle commands. Keep executable registrations explicit.
5. Compare direct/generated results; test changed closure rejection, layouts, invalid output, replay, and tampered bundles.
6. Record the native-export supported boundary and recommendation in an ADR.

Acceptance: one meaning across UI/CLI; file generation works without the UI; uncertain/native failures cannot become success.
