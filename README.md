# Rigg

Rigg is a local-first workflow runner for agentic coding.

As more engineering work moves into local AI agents, teams need a way to turn the good repetitive parts of their day-to-day workflow into something explicit and reusable: implementation planning, review loops, fix verification, codebase checks, and other multi-step flows that are usually done ad hoc in prompts and terminals.

Rigg lets you capture those workflows as `.rigg/*.yaml`, run them locally with tools like Codex and Claude, and keep them in Git alongside the code they operate on. That makes agent workflows easier to review, share, standardize, and evolve as a team, instead of living as private prompt habits.

The goal is to help teams use local coding agents in a safer and more repeatable way: common workflows are versioned, execution is visible, and every run is recorded under `.rigg/runs/`.

## Requirements

- Rust `1.94.0`
- `codex` on `PATH` for `type: codex` steps
- `claude` on `PATH` for `type: claude` steps

## Install

```bash
curl -fsSL https://tryrigg.com/install | bash
```

Install a specific version:

```bash
curl -fsSL https://tryrigg.com/install | bash -s -- --version v0.1.0
```

The installer currently supports macOS and installs a prebuilt `rigg` binary from GitHub Releases.

Or build from source:

```bash
cargo install --path crates/cli
cargo run -p rigg-cli -- --help
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

Inspect past runs:

```bash
rigg status
rigg status <run_id> --json
rigg logs <run_id>
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

- Actions: `shell`, `codex`, `claude`, `write_file`
- Control flow: `group`, `loop`, `branch`, `parallel`

## Notes

- Workflows are discovered from the nearest `.rigg/` directory.
- `rigg run --json` writes a JSON snapshot to stdout.
- Interactive runs show live progress; `--json`, `--quiet`, and non-TTY runs do not.
- Run data is stored under `.rigg/runs/<run_id>/`.

## Docs

- [Getting started](https://tryrigg.com/docs/)
- [Workflows](https://tryrigg.com/docs/workflows/) — steps, control flow, expressions, conversations
- [Schema reference](https://tryrigg.com/docs/reference/schema/)
- [CLI reference](https://tryrigg.com/docs/reference/cli/)
- [Examples](https://tryrigg.com/docs/examples/)

## Development

```bash
cargo test
```
