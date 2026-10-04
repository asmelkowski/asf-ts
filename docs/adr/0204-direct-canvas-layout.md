# ADR 0204: Keep canvas movement separate from workflow execution

## Context

Studio places blocks by array order and requires numeric coordinate edits. A second parallel outcome appears far from its sibling. Adding a block to a branch also needs an explicit outgoing connection.

## Decision

Retain the local SVG renderer. Place inserted blocks beside their selected connection and preserve its prior successor. Expose true and false branch ports. Use pointer capture and inverse SVG coordinates for drag preview; persist document layout only after an accepted move. Cancel restores the prior layout. Add zoom, fit, canvas panning, keyboard movement and direction buttons. Preserve invalid drafts and the download validation guard.

## Why

The current data-only editor can support these interactions without changing the validator, executor or file format. Layout remains presentation data and does not change semantic workflow identity. Direction buttons provide a single-pointer alternative to dragging, following [WCAG dragging guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html). [React Flow's node patterns](https://reactflow.dev/learn/customization/custom-nodes) and [layout guidance](https://reactflow.dev/learn/layouting/layouting) inform the design; this decision does not add React Flow as a dependency.
