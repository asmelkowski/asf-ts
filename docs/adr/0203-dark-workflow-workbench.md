# ADR 0203: Use a dark workflow workbench by default

## Context

The user finds the light pages, weak section titles and uniform block shapes confusing. Studio shares styles with the original execution inspector. Declared inspection has separate theme rules.

## Decision

Use shared dark color tokens on all three pages, regardless of the operating-system preference. Give headings, controls, panels and selected states a consistent hierarchy. Studio separates the definition library, canvas and block properties. Distinguish block kinds with shape, icon, text and accent color. Keep definition management and advanced source editing collapsed until needed; keep definition selection visible. Use local system fonts and existing static assets.

## Why

A common palette prevents mixed light and dark surfaces. Shape and text retain meaning without relying on color. Clear visual hierarchy helps authors find the current task. Local assets preserve the existing same-origin content policy without a new framework or external font request. The [NN/G hierarchy guidance](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/) and [dark-mode research](https://www.nngroup.com/articles/dark-mode-users-issues/) support consistent contrast and visible section boundaries.
