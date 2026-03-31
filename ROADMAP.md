# a2a-crews — Roadmap

## v0.1 (current) — Foundation

### Done ✅
- CLI: plan, apply, launch, watch, stop, templates
- Embedded A2A bridge (Bun.serve, JSON-RPC, SSE, 8 endpoint groups)
- Crew/Agent/Task classes (CrewAI-inspired)
- Wave computation with dependency scheduling
- 13 template presets (feature, fullstack, sprint, bugfix, refactor, research, audit, ship, harness, data-science, ml-experiment, data-pipeline, doc-review)
- Template matching (keyword-based)
- Cross-platform terminal spawning (Windows Terminal / tmux)
- Agent prompt generation with bridge completion
- Evidence-based recovery (deliverable file detection)
- Post-exit bridge notification
- Event bus for telemetry
- 53 tests, 278 assertions
- CI pipeline (GitHub Actions)
- Architecture Decision Records (10 ADRs)

### In Progress
- Heuristic feasibility assessment
- Compiled binary (bun build --compile)

## v0.2 — Smart Planning
- [ ] AI-powered feasibility (spawn assessor agents via bridge)
- [ ] Role library (30+ reusable role definitions)
- [ ] Confidence-based task routing (skill matching)
- [ ] Plan from AI (not just template matching)

## v0.3 — Reliability
- [ ] Auto-retry on agent failure (heartbeat-based dead detection)
- [ ] Poison pill (max 3 retries per agent)
- [ ] Context checkpoint + handoff protocol
- [ ] Task event log (WAL for audit trail)

## v0.4 — Feedback Loops
- [ ] Review feedback loop (reviewer creates fix tasks)
- [ ] Structured grading criteria with thresholds
- [ ] Harness mode (generator ↔ evaluator iteration)

## v0.5 — Cross-Platform
- [ ] macOS support (tmux spawning verified)
- [ ] Linux support
- [ ] npm global install: `npm install -g a2a-crews`
- [ ] Compiled binaries for all platforms

## v1.0 — Production
- [ ] Interface contracts for cross-boundary file access
- [ ] File locking protocol
- [ ] A2A interop: external agents can join a crew
- [ ] Web dashboard
- [ ] Cost tracking (token usage per agent)

## Principles
1. A2A is the coordination layer. Push-based, standard, interoperable.
2. User types one command. Everything else is automatic.
3. Feasibility before tokens. Never start work that's doomed.
4. Every feature backed by research (ADRs cite sources).
5. Tests cover everything. 53+ and growing.
