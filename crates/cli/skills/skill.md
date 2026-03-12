---
name: rigg
description: Write and edit Rigg workflow YAML files (.rigg/*.yaml). Use when creating, modifying, or debugging Rigg workflows, or when the user asks about Rigg YAML syntax, step types, expressions, or workflow structure.
user-invocable: true
---

# Rigg Workflow Authoring

This project uses **Rigg**, a local-first workflow builder for coding. Workflow YAML files live in `.rigg/`.

When writing or editing Rigg workflow files, read the documentation in `.rigg/docs/`:

- `.rigg/docs/workflow-syntax.md` — YAML syntax, all step types, expression language, CLI commands
- `.rigg/docs/schema-reference.md` — Complete field-by-field schema with types, defaults, and constraints
- `.rigg/docs/examples.md` — Common workflow patterns (review loops, parallel execution, branching, etc.)

Always read these files before creating or modifying workflows to ensure valid YAML.

## Online Documentation

For the latest and most detailed documentation, see:

- https://tryrigg.com/docs/ — Getting started guide
- https://tryrigg.com/docs/workflows/ — Workflow concepts (steps, control flow, expressions, conversations)
- https://tryrigg.com/docs/reference/schema — Complete schema reference
- https://tryrigg.com/docs/reference/cli — CLI command reference
- https://tryrigg.com/docs/examples/ — Workflow examples and patterns
