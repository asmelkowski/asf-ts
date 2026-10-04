# ADR 0205: Edit named personas through structured controls

## Context

Studio creates profiles through a JSON textarea. The user needs clear controls for each persona's instructions, model, tools and plugins. Existing workflow defaults and agent-node overrides already resolve named profiles.

## Decision

Use a dedicated persona editor over the existing document-wide `profiles` library. Keep advanced JSON editing. Expose instruction delivery, model, tool selection, mode, timeout and session intent. Preserve the difference between an omitted selection and an explicit empty list. Rename updates assignments atomically; delete reports affected assignments. Use Studio's existing drafts and validation revision as the authority.

Validate workflow and node profile references against the parsed profile library. Preserve its 128-character name limit independently of the 100-character node ID limit.

## Why

Structured controls make the existing configuration discoverable without a second file format or execution path. Explicit instruction delivery avoids presenting prompt guidance as enforced native system instructions. Shared draft handling prevents typed controls from overwriting unapplied source or invalid JSON.
