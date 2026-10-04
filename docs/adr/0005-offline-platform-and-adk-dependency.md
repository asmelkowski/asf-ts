# ADR 0005: Keep offline checks portable and pin ADK dependencies

## Context

The Linux baseline uses Node 22. Two baseline tests fail on macOS: `/bin/true` is absent, and `/var` resolves to `/private/var`, changing a manually forged action identity. The optional ADK2.2.0 package imports on Node 22 but brings a vulnerable uuid9 through gaxios6.7.1.

## Decision

Use the current Node executable for the zero-work command fixture. Use Runtime's canonical cwd when forging the uncertain-command fixture. Add the same offline check to GitHub Actions. Keep Node 22 and pin optional `@google/adk@2.2.0`. Override gaxios's uuid dependency to 11.1.1; its inspected source calls only `v4()`, whose API is compatible. Test the actual SDK without providers. Keep optional installed-native-CLI checks separate.

## Why

These test changes exercise the same behavior on both hosts. They do not alter process or runtime behavior. The dependency override removes the reported buffer-bounds vulnerability while preserving native provider pins and a tested v4 call. Node24 remains an SDK quickstart recommendation rather than an assumed core requirement.
