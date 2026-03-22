# Rigg

Rigg is a local-first workflow runner for agentic coding.

As more engineering work moves into local AI agents, teams need a way to turn the good repetitive parts of their day-to-day workflow into something explicit and reusable: implementation planning, review loops, fix verification, codebase checks, and other multi-step flows that are usually done ad hoc in prompts and terminals.

Rigg lets you capture those workflows as `.rigg/*.yaml`, run them locally with Codex, Cursor, and shell commands, and keep them in Git alongside the code they operate on. That makes agent workflows easier to review, share, standardize, and evolve as a team, instead of living as private prompt habits.

[![Rigg demo](https://github.com/user-attachments/assets/3e4ba894-33d9-4972-8f34-19c503d421f2)](https://tryrigg.com)

## Requirements

- Bun `1.3.10`
- `codex` on `PATH` for `type: codex` steps
- `codex-cli 0.114.0` or newer
- `cursor` on `PATH` for `type: cursor` steps

## Install

```bash
curl -fsSL https://tryrigg.com/install | bash
```

Install a specific version:

```bash
curl -fsSL https://tryrigg.com/install | bash -s -- --version v0.1.0
```

Upgrade an installed release binary:

```bash
rigg upgrade
rigg upgrade v0.1.0
```

The installer currently supports macOS and installs a prebuilt `rigg` binary from GitHub Releases.

Or build from source:

```bash
bun install --frozen-lockfile
bun run --cwd packages/rigg build:cli
./packages/rigg/dist/rigg --help
```

For local debugging against the workspace implementation:

```bash
bun run rigg --version
bun run rigg validate
bun run rigg run debug-progress
```

## Quickstart

Initialize a project:

```bash
rigg init
```

Validate workflows:

```bash
rigg validate
```

Run a workflow:

```bash
rigg run <workflow_id> --input key=value
```

`--input key=value` parses JSON when possible, so values like `true`, `42`, `["a"]`, and `{"x":1}` work as expected.

## Workflow example

```yaml
id: smoke
inputs:
  name:
    type: string
steps:
  - id: greet
    type: shell
    with:
      command: echo "hello ${{ inputs.name }}"
      result: text
```

Supported step types:

- Actions: `shell`, `codex`, `cursor`, `write_file`
- Control flow: `group`, `loop`, `branch`, `parallel`

## Notes

- Workflows are discovered from the nearest `.rigg/` directory.
- `rigg run` opens a stateful terminal UI on TTYs with a run header, active pane, interaction pane, and barrier pane.
- Barrier steps can be advanced with `continue` or stopped with `abort`.
- Provider interactions are answered in place from the terminal UI; `Ctrl-C` interrupts the active step.
- Run state is in-memory only; Rigg does not persist run history.

## Docs

- [Getting started](https://tryrigg.com/docs/)
- [Workflows](https://tryrigg.com/docs/workflows/) — steps, control flow, expressions
- [Schema reference](https://tryrigg.com/docs/reference/schema/)
- [CLI reference](https://tryrigg.com/docs/reference/cli/)
- [Examples](https://tryrigg.com/docs/examples/)

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run test
```
