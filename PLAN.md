# a2a-crews — Build Plan

## Phase 0: Scaffold (now)
**Goal:** Repo exists, CLI skeleton works, README sells the vision.

- [ ] Bun project with TypeScript
- [ ] CLI entry point: `crews` with subcommands (plan, apply, launch, watch, stop)
- [ ] Port 13 template presets from agent-teams (JSON, no changes)
- [ ] README with vision, architecture Mermaid diagram, install instructions
- [ ] LICENSE (MIT)
- [ ] .gitignore
- [ ] GitHub repo created and pushed
- [ ] CI: GitHub Actions (bun test)

**Exit:** `bun run src/index.ts plan --help` shows usage. README is compelling.

## Phase 1: Embedded A2A Bridge
**Goal:** Lightweight A2A server running on localhost.

- [ ] Implement minimal A2A JSON-RPC 2.0 server (Bun.serve)
- [ ] Agent registration: POST /agents (name, skills, description)
- [ ] Task send: POST /a2a/{agent} with SendMessage
- [ ] Task status: GET /tasks/{id}
- [ ] SSE streaming: GET /agents/{name}/events (push updates)
- [ ] Health: heartbeat endpoint + stale detection
- [ ] GET /status (all agents, tasks, health)

**Exit:** Can register 2 agents, send a task from one to another, get completion event via SSE.

## Phase 2: Agent Spawning
**Goal:** `crews launch` spawns Copilot CLI sessions that connect to the bridge.

- [ ] Spawn terminal tabs (wt.exe on Windows, tmux on macOS/Linux)
- [ ] Each tab runs copilot -p with a role prompt
- [ ] Agent auto-registers with bridge on startup (via MCP or prompt instructions)
- [ ] Agent receives tasks from bridge
- [ ] Agent reports completion back to bridge
- [ ] .done detection via A2A task lifecycle (not files)

**Exit:** `crews launch` spawns 3 tabs, agents register, receive tasks, complete them, bridge knows.

## Phase 3: Orchestration
**Goal:** Full plan → apply → launch → watch flow.

- [ ] `crews plan` — spawn assessor agents, collect feasibility via A2A
- [ ] `crews apply` — read plan, show feasibility gate, create team
- [ ] `crews launch` — wave-based execution with dependency scheduling
- [ ] Auto-retry on agent failure (bridge detects via heartbeat timeout)
- [ ] `crews watch` — stream from bridge /status endpoint
- [ ] `crews stop` — cancel all tasks on bridge
- [ ] Execution summary (timing, waves, agent stats)

**Exit:** Full E2E: plan → apply → launch → agents build a calculator → tests pass.

## Phase 4: Polish
**Goal:** Production-quality, cross-platform, portfolio-ready.

- [ ] Cross-platform spawning (wt.exe / tmux / iTerm2)
- [ ] `bun build --compile` → single binary
- [ ] Full test suite (unit + integration)
- [ ] README v2 with aha moments, real E2E output
- [ ] ROADMAP.md, CONTRIBUTING.md
- [ ] Starship compatibility doc (parallel comparison)

**Exit:** `npm install -g a2a-crews` works. Binary runs on Windows + macOS. E2E passes.
