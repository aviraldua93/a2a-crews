# a2a-crews

Turn one command into a task-specific crew of AI coding agents. `a2a-crews` plans work, creates agent roles, and coordinates execution through an A2A bridge so multi-step coding tasks can run in organized waves.

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org/)

## Requirements

- [Bun](https://bun.sh/) 1.0 or newer (the CLI and scripts run on Bun)
- npm (this repository includes `package-lock.json`, so use npm for dependency installation)
- Git
- GitHub Copilot CLI for AI-planner/agent execution workflows
- Windows Terminal on Windows, or tmux/iTerm-compatible terminal support on macOS/Linux for spawned agents

## Quickstart / install

```bash
npm install
```

Run the TypeScript CLI directly during development:

```bash
npm run dev -- plan "Build a REST API with auth and tests"
npm run dev -- apply
npm run dev -- launch
```

Or build a standalone executable:

```bash
npm run build
```

On Windows, the build outputs `crews.exe`; on Unix-like systems it outputs `crews`.

## How to run

Common commands:

```bash
# Show help
npm run dev -- --help

# List preset crew templates
npm run dev -- templates

# Plan a crew for the current directory
npm run dev -- plan "Build a dashboard"

# Target another project directory
npm run dev -- -d /path/to/project plan "Fix flaky tests"

# Review the generated plan and create a team
npm run dev -- apply

# Launch, watch, and stop a team
npm run dev -- launch <team-name>
npm run dev -- watch <team-name>
npm run dev -- stop <team-name>
```

### Goal loop

`crews goal` drives a durable, evaluator-graded goal loop whose state is persisted under `audits/goals/`:

```bash
# Show the active goal (default), or print the full contract
npm run dev -- goal status
npm run dev -- goal show

# Activate a goal from a 7-field contract JSON, then pause/resume/clear
npm run dev -- goal start path/to/contract.json
npm run dev -- goal pause
npm run dev -- goal resume
npm run dev -- goal clear
```

The CLI writes runtime state under `.a2a-crews/` in the target project. That directory is ignored by git.

## How to test

```bash
npm run typecheck
npm test
```

For the same validation used before publishing changes, run:

```bash
npm run build
npm run typecheck
npm test
```

## Project structure

- `src/cli/` - command-line interface
- `src/a2a/` - A2A bridge, client, discovery, and protocol types
- `src/crew/` - agents, tasks, wave scheduling, checkpoints, and crew execution
- `src/planner/` - template matching, feasibility assessment, and AI planner integration
- `src/spawner/` - terminal and worktree spawning helpers
- `src/templates/` - preset crew templates
- `src/goal/` - durable goal-loop contracts, storage, runner, and evaluator
- `tests/` - Bun test suite
- `docs/` - A2A research and architecture notes

## License

[MIT](LICENSE) © 2026 Aviral Dua
