# ADR 0007: Specify portable hashes and bind recipient code

## Context

Legacy util hashing accepts 256 KiB and sorts keys with localeCompare. Portable documents allow 1 MiB. Recipient code and targets affect execution but must not enter shared bundles.

## Decision

Use a separate portable canonical serializer: JSON primitives, JSON integer-index keys in numeric order and remaining keys in UTF-16 code-unit order, array order retained. SHA-256 covers the semantic closure; layout and node-list presentation order are excluded. Keep legacy hashes unchanged. Recipient component/target modules load only for explicit execution. Bind their raw entry bytes plus declared dependency/capability revisions. Generated drivers check frozen entry hashes before importing them. Components remain responsible for declaring transitive dependency identity.

## Why

The document limit and hash contract now agree across hosts. Existing action/session identity remains intact. Local code cannot silently change behind portable replay identity. General import-tree hashing and hostile module containment are outside this trusted-code boundary.

Load each trusted entry with its SHA-256 in the module URL. Check the raw bytes before and after import. This prevents an old ESM cache entry from receiving a new source identity. Reject changes during import. The caller still supplies a revision for transitive dependencies.
