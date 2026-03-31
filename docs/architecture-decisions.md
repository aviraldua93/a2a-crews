# a2a-crews — Architecture Decision Record

## Research Sources
- Official A2A proto spec (a2aproject/A2A/specification/a2a.proto)
- python-a2a SDK (988⭐, most popular A2A implementation)
- CrewAI source code (47K⭐, production orchestration framework)
- a2alite TypeScript SDK (lightweight, Bun-compatible)
- Official a2a-js SDK (a2aproject/a2a-js)

## ADR-001: Use official @a2a-js/sdk, don't reimplement types

**Decision:** Import `@a2a-js/sdk` for A2A types, server primitives, and JSON-RPC dispatch.
**Source:** a2aproject/a2a-js exists as the official TypeScript SDK.
**Rationale:** Reimplementing 30+ proto types is error-prone and drifts from spec. The official SDK tracks spec changes.
**What we build:** Thin wrapper for our use case (embedded bridge, agent spawning).

## ADR-002: Follow python-a2a's HTTP route structure

**Decision:** Expose these endpoints on our embedded bridge:
```
GET  /.well-known/agent.json    → Agent card (A2A standard)
POST /                          → JSON-RPC 2.0 dispatch
GET  /status                    → Bridge health + agent list
```
**Source:** python-a2a's multi-route pattern with JSON-RPC auto-detection.
**Rationale:** Maximum compatibility with any A2A client.

## ADR-003: Follow CrewAI's Crew/Agent/Task class separation

**Decision:** Three core classes:
- `Crew` — orchestrator (manages lifecycle, routes process strategy)
- `Agent` — executor (wraps a Copilot CLI session + A2A communicator)
- `Task` — work unit (description, assigned agent, deps, acceptance criteria)
**Source:** CrewAI's crew.py, agent/core.py, task.py.
**Rationale:** 47K stars, battle-tested. Same mental model works.

## ADR-004: Sequential process only for v0.1 (not hierarchical)

**Decision:** Start with sequential/wave process. No manager agent yet.
**Source:** CrewAI supports both but sequential is used 90% of the time.
**Rationale:** Hierarchical adds manager agent complexity. Wave execution (our proven pattern from agent-teams) maps to sequential + dependency ordering.

## ADR-005: Task lifecycle follows A2A spec exactly

**Decision:** Use official TaskState enum:
```
submitted → working → completed
                   → failed
                   → canceled
                   → input_required
```
**Source:** A2A proto spec TaskState enum.
**Rationale:** Compliance with the standard. No custom states.

## ADR-006: SSE for real-time updates (not polling)

**Decision:** Bridge pushes events via SSE. CLI streams from bridge.
**Source:** python-a2a's SSE implementation + A2A spec streaming support.
**Rationale:** Eliminates polling latency. Push-based is the A2A way.

## ADR-007: Dynamic tool composition per task (CrewAI pattern)

**Decision:** Don't inject all tools at agent creation. Compose per task execution.
**Source:** CrewAI's `_prepare_tools()` method.
**Rationale:** Different tasks need different tools. Architect doesn't need `edit`, coder does.

## ADR-008: Context as immutable data flow (CrewAI pattern)

**Decision:** Each task receives prior task outputs as context. No shared mutable state.
**Source:** CrewAI's `_get_context(task, task_outputs)`.
**Rationale:** Prevents race conditions, makes task execution deterministic.

## ADR-009: Event bus for telemetry (CrewAI pattern)

**Decision:** Emit events for crew lifecycle: started, task_completed, agent_failed, crew_completed.
**Source:** CrewAI's `crewai_event_bus.emit()`.
**Rationale:** Enables `crews watch` without tight coupling. Also feeds logging.

## ADR-010: A2A agent card per spawned agent

**Decision:** Each spawned Copilot CLI session publishes an agent card with its skills.
**Source:** A2A spec AgentCard + python-a2a's discovery endpoints.
**Rationale:** Makes our agents discoverable by any A2A client, not just our CLI.

## Revised Source Code Structure

Based on research, here's what we build vs import:

```
src/
├── a2a/                      # THIN WRAPPER around @a2a-js/sdk
│   ├── bridge.ts             # Embedded A2A server (Bun.serve + JSON-RPC dispatch)
│   │                         # Source: python-a2a route structure
│   ├── communicator.ts       # A2A client that runs alongside each agent
│   │                         # Source: a2alite AgentExecutor pattern
│   └── discovery.ts          # Agent card publishing + well-known endpoint
│                             # Source: A2A spec section 7 (Agent Card)
│
├── crew/                     # CORE ORCHESTRATION (CrewAI patterns)
│   ├── crew.ts               # Crew class — kickoff(), process routing, lifecycle
│   │                         # Source: CrewAI crew.py kickoff() flow
│   ├── agent.ts              # Agent class — wraps Copilot CLI + A2A communicator
│   │                         # Source: CrewAI agent/core.py
│   ├── task.ts               # Task class — deps, acceptance criteria, output
│   │                         # Source: CrewAI task.py + A2A Task lifecycle
│   ├── process.ts            # Process strategies: sequential (wave-based)
│   │                         # Source: CrewAI Process enum + our wave pattern
│   └── events.ts             # Event bus for telemetry
│                             # Source: CrewAI crewai_event_bus
│
├── planner/                  # OUR UNIQUE LAYER (no external source — our IP)
│   ├── assessor.ts           # Feasibility assessment agents
│   ├── composer.ts           # Team composition from templates
│   └── plan.ts               # Plan data model
│
├── spawner/                  # AGENT LIFECYCLE (our unique contribution)
│   ├── terminal.ts           # Cross-platform tab spawning (wt/tmux)
│   └── prompt.ts             # Role prompt generation
│
├── cli/                      # USER INTERFACE
│   ├── index.ts              # Entry point + subcommand dispatch
│   ├── plan.ts
│   ├── apply.ts
│   ├── launch.ts
│   ├── watch.ts
│   └── stop.ts
│
└── templates/                # PRESETS (carry from agent-teams)
    └── presets/              # 13 JSON files
```

## What's imported vs built

| Component | Import from | Build ourselves |
|-----------|-------------|-----------------|
| A2A types (Task, Message, AgentCard, Part, Artifact) | @a2a-js/sdk | — |
| JSON-RPC dispatch | @a2a-js/sdk | Route wiring for Bun.serve |
| TaskState enum | @a2a-js/sdk | — |
| SSE streaming | Bun native | Event format matching A2A spec |
| Crew orchestration | — | Yes (inspired by CrewAI patterns) |
| Agent lifecycle | — | Yes (Copilot CLI spawning) |
| Task dependency scheduling | — | Yes (our wave pattern) |
| Feasibility assessment | — | Yes (our unique IP) |
| Templates | — | Yes (carry from agent-teams) |
| CLI | — | Yes (Bun + commander or custom) |
