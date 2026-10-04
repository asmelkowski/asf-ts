# ADR 0213: Keep explicit schema dialects and authored snapshots

## Context

Existing agents use strict Ajv draft-07. Portable documents may declare draft2020-12 contracts and contain a diagram larger than one schema. Observation traces cannot reconstruct an authored graph exactly.

## Decision

Keep strict draft-07 as the default. An explicit draft2020-12 URI selects Ajv2020. Use the same compiler for agent and workflow schemas without coercion. Bound schemas to 16 KiB, selected inputs to 64 KiB, local JSON output to 256 KiB, and authored documents and child aggregates to 1 MiB. Reject non-JSON values and more than 64 data levels. Store the first exact authored document separately from the caller-owned semantic code identity. Identify that snapshot by SHA256 of its serialized JSON. Expose exact definitions, invocation bindings, and action ownership in the composition inspector.

## Why

Explicit dialect selection supports modern contracts while retaining old agent semantics. Bounded separate snapshots preserve diagram evidence without turning trace events into execution authority. Authored layout changes cannot overwrite the original execution source.
