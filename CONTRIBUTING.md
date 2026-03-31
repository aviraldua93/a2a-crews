# Contributing to a2a-crews

## Dogfood Rule
Use a2a-crews itself (or agent-teams) to develop features when scope warrants it.

## Development Setup
```bash
git clone https://github.com/aviraldua93/a2a-crews.git
cd a2a-crews
bun install
bun test
```

## Branch Strategy
```
main     ← stable
develop  ← integration
feature/* ← feature branches off develop
```

## Pull Requests
1. Create feature branch: `git checkout -b feature/my-change`
2. Write code + tests
3. Run `bun test` — all tests must pass
4. Push and create PR to `develop`
5. Get review
6. Merge

## Architecture Decisions
Major decisions are documented in `docs/architecture-decisions.md` with sources.
Every structural decision must cite its research source.

## Testing
- `bun test` runs all tests
- Tests live in `tests/`
- New templates need validation tests
- New bridge endpoints need HTTP tests
- Aim for >90% coverage

## Filing Issues
- Use GitHub Issues
- Label: `bug`, `enhancement`, `v0.x`, `v1.0`
- Include: what happened, expected, repro steps
