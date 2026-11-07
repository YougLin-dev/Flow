# Architecture decision records

An ADR records a decision that changes the project's architecture, public
surface, dependencies, release process or security posture. The standard in
[../standards.md](../standards.md) says when one is required.

Use the next number and a kebab-case title:

```text
NNNN-short-title.md
```

Each record starts with:

```markdown
# NNNN: Short title

- **Status:** Proposed | Accepted | Superseded by NNNN
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
