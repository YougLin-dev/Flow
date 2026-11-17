# Architecture decision records

An ADR records a decision that changes the project's architecture, public
surface, dependencies, release process or security posture. The standard in
[../standards.md](../standards.md) says when one is required.

## Index

| ADR                                      | Title                                 | Status                                                                                          |
| ---------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [0001](0001-platform-adapter-split.md)   | Split the platform adapter            | Accepted; Leafer premise superseded in part by 0004                                             |
| [0002](0002-rust-document-core.md)       | Rust document core with SQLite        | Accepted; Leafer scene premise superseded in part by 0004                                       |
| [0003](0003-orm-seaorm.md)               | SeaORM Sync for the document database | Accepted; P0 table list historical (v1 removed `documents`, `node_assets`, `schema_migrations`) |
| [0004](0004-native-view-canvas.md)       | Native-view canvas                    | Accepted; supersedes the Leafer premise of 0001/0002                                            |
| [0005](0005-connector-canvas-strokes.md) | Connector canvas strokes              | Accepted; narrows 0004's connector consequence                                                  |
| [0006](0006-lucide-icons.md)             | Lucide icons                          | Accepted                                                                                        |
| [0007](0007-code-organization.md)        | Layer × area organization             | Accepted                                                                                        |
| [0008](0008-zip-dependency.md)           | Zip dependency for project import     | Accepted                                                                                        |

Use the next number and a kebab-case title:

```text
NNNN-short-title.md
```

Each record starts with:

```markdown
# NNNN: Short title

- **Status:** Proposed | Accepted | Superseded by NNNN | Superseded in part by NNNN
- **Date:** YYYY-MM-DD
- **Deciders:** who agreed

## Context

What problem are we solving? What constraints and current behavior matter?

## Decision

What are we doing, and where does it live?

## Consequences

What becomes easier or harder? What debt or migration remains?

## Alternatives considered

What else was viable, and why was it rejected?
```

Accepted records are immutable; supersede one with a new record instead of
editing it. Routine fixes and pattern-following components do not need an ADR.
