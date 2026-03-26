# Rigg

Rigg is a local-first workflow runner for agentic coding.

As more engineering work moves into local AI agents, teams need a way to turn the good repetitive parts of their day-to-day workflow into something explicit and reusable: implementation planning, review loops, fix verification, codebase checks, and other multi-step flows that are usually done ad hoc in prompts and terminals.

Rigg lets you capture those workflows as `.rigg/*.yaml`, run them locally with Codex, Claude Code, Cursor, and shell commands, and keep them in Git alongside the code they operate on. That makes agent workflows easier to review, share, standardize, and evolve as a team, instead of living as private prompt habits.

[![Rigg demo](https://github.com/user-attachments/assets/3e4ba894-33d9-4972-8f34-19c503d421f2)](https://tryrigg.com)

## Requirements

- Bun `1.3.10`
- `codex` on `PATH` for `type: codex` steps
- `codex-cli 0.114.0` or newer
- `claude` on `PATH` for `type: claude` steps
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

List workflows:

```bash
rigg list
```

Validate workflows:

```bash
rigg validate
```

Run a workflow:

```bash
rigg run <workflow_id> --input key=value
rigg run <workflow_id> --headless --output-format json
```

`--input key=value` parses JSON when possible, so values like `true`, `42`, `["a"]`, and `{"x":1}` work as expected.

Inspect local run history:

```bash
rigg history
rigg show <run_id>
rigg logs [run_id] [step]
```

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
      stdout:
        mode: text
```

Supported step types:

- Actions: `shell`, `codex`, `claude`, `cursor`, `write_file`
- Control flow: `group`, `loop`, `branch`, `parallel`

## Notes

- Workflows are discovered from the nearest `.rigg/` directory.
- `rigg run` opens a stateful terminal UI by default when `stdin` and `stderr` are attached to a TTY.
- `rigg run --auto-continue` only works in that interactive TTY UI. Barriers advance automatically there, but approvals and workflow input prompts still pause normally.
- `rigg run --headless` skips the TTY requirement, auto-continues step barriers, and is intended for scripts and CI.
- Headless text mode prints the final workflow result to `stdout`. Add `--verbose` to also stream step output and lifecycle markers as the run executes.
- `rigg run --headless --output-format json` emits one final summary object. `--output-format stream-json` emits newline-delimited JSON events plus a final summary record.
- Headless runs must receive all required workflow inputs via `--input` or workflow defaults before execution starts.
- Barrier steps can be advanced with `continue` or stopped with `abort`.
- Provider interactions are answered in place from the terminal UI; `Ctrl-C` interrupts the active step.
- When the local history database is available, runs are recorded for `rigg list`, `rigg history`, `rigg show`, and `rigg logs`.

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
