# ADR 0202: Keep Studio authoring separate from file execution

## Context

The existing browser inspects retained runs. Users also need to author portable
workflow documents. The user requires file generation and execution outside the web UI.

## Decision

Add `/studio` for data editing and one bounded `/studio/validate` endpoint. Reuse the
portable parser, validator, catalogue, and serializer. Download valid YAML or JSON in
the browser. Keep compilation, execution, rendering, bundles, local bindings, and
server file paths in CLI and library APIs. Keep the existing inspection view and guards.

## Why

One validation contract prevents editor and CLI drift. A separate data boundary keeps
local target policy and credentials out of imported files. Declared transitions and
recorded scope membership describe different relationships and need separate views.
