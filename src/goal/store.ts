/**
 * Durable, git-trackable persistence for goals — the second tier of the
 * two-tier memory model.
 *
 * Working state (turn/token counters, in-memory plan, latest checkpoint) lives
 * in the {@link GoalRunner}. Durable state lives on disk under
 * `audits/goals/<id>/`:
 *
 *   - `contract.json`      the 7-field contract + record metadata (machine)
 *   - `goal.md`            the same contract, human-readable (git-trackable)
 *   - `checkpoints.jsonl`  append-only checkpoint log (one JSON object per line)
 *   - `retrospective.md`   written on clear/complete
 *
 * Fixes carried over from the source design:
 *   - Durability: every write also *stages* its files (`git add`) so durable
 *     files are never left untracked after a checkpoint.
 *   - Idempotency: checkpoints are keyed; re-appending the same key is a no-op,
 *     and record/markdown writes overwrite rather than duplicate.
 *   - Portability: timestamps come from the JS runtime (never `date -u`), and
 *     staging shells out via argv (no shell string), so it works on Windows
 *     (PowerShell) and Unix alike.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import type { GoalContract, GoalState } from './contract';
import { contractToMarkdown } from './contract';
import type { Evidence } from './evaluator';

export interface GoalRecord {
  id: string;
  contract: GoalContract;
  state: GoalState;
  branch?: string;
  autopilot: boolean;
  createdAt: string;
  updatedAt: string;
  achievedCondition?: string | null;
}

export interface GoalCheckpointValidation {
  command?: string;
  result?: string;
  passed: boolean;
  /** Verification attempt count for this slice. Starts at 0; first attempt is 1. */
  attempt: number;
}

export interface GoalCheckpoint {
  goalId: string;
  checkpointNumber: number;
  turn: number;
  timestamp: string;
  title: string;
  verified: string;
  remains: string;
  blocked: string | null;
  validation: GoalCheckpointValidation;
  evidence: Evidence;
  evaluatorId: string;
  progress: number;
  commitSha?: string;
  /** Idempotency key — appending the same key twice is a no-op. */
  key: string;
}

/** A checkpoint before the store assigns its sequence number. */
export type GoalCheckpointDraft = Omit<GoalCheckpoint, 'checkpointNumber'>;

export type StageFn = (paths: string[], repoDir: string) => void;

export interface GoalStoreOptions {
  /** Root under which `audits/goals/<id>/` is written. Defaults to cwd. */
  baseDir?: string;
  /** Whether to `git add` durable files after each write. Defaults to true. */
  autoStage?: boolean;
  /** Override the staging implementation (injected in tests). */
  stage?: StageFn;
  /** Timestamp source. Defaults to the runtime ISO clock (never a shell). */
  now?: () => string;
}

/** Best-effort cross-platform `git add` via argv (no shell). */
export function defaultStage(paths: string[], repoDir: string): void {
  if (paths.length === 0) return;
  try {
    spawnSync('git', ['add', '--', ...paths], { cwd: repoDir, stdio: 'ignore' });
  } catch {
    // Staging is best-effort: durability of the files themselves does not
    // depend on the working tree being a git repo.
  }
}

/** Compute a deterministic idempotency key for a checkpoint's content. */
export function checkpointKey(parts: {
  goalId: string;
  turn: number;
  title: string;
  verified: string;
  validationResult?: string;
  reason: string;
}): string {
  const material = [
    parts.goalId,
    String(parts.turn),
    parts.title,
    parts.verified,
    parts.validationResult ?? '',
    parts.reason,
  ].join('\u0000');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export class GoalStore {
  readonly baseDir: string;
  private readonly autoStage: boolean;
  private readonly stageFn: StageFn;
  readonly now: () => string;

  constructor(options: GoalStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? process.cwd());
    this.autoStage = options.autoStage ?? true;
    this.stageFn = options.stage ?? defaultStage;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  goalsRoot(): string {
    return join(this.baseDir, 'audits', 'goals');
  }
  goalDir(id: string): string {
    return join(this.goalsRoot(), id);
  }
  contractJsonPath(id: string): string {
    return join(this.goalDir(id), 'contract.json');
  }
  goalMdPath(id: string): string {
    return join(this.goalDir(id), 'goal.md');
  }
  checkpointsPath(id: string): string {
    return join(this.goalDir(id), 'checkpoints.jsonl');
  }
  retrospectivePath(id: string): string {
    return join(this.goalDir(id), 'retrospective.md');
  }

  private ensureDir(id: string): void {
    mkdirSync(this.goalDir(id), { recursive: true });
  }

  private maybeStage(paths: string[]): void {
    if (this.autoStage) this.stageFn(paths, this.baseDir);
  }

  /** Persist the record (contract.json + goal.md). Overwrites — idempotent. */
  writeRecord(record: GoalRecord): string[] {
    this.ensureDir(record.id);
    const jsonPath = this.contractJsonPath(record.id);
    const mdPath = this.goalMdPath(record.id);
    writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    writeFileSync(
      mdPath,
      contractToMarkdown(record.contract, {
        id: record.id,
        state: record.state,
        branch: record.branch,
        startedAt: record.createdAt,
        lastCheckpointAt: record.updatedAt,
        autopilot: record.autopilot,
      }),
      'utf-8',
    );
    const paths = [jsonPath, mdPath];
    this.maybeStage(paths);
    return paths;
  }

  readRecord(id: string): GoalRecord | null {
    const path = this.contractJsonPath(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as GoalRecord;
    } catch {
      return null;
    }
  }

  listRecords(): GoalRecord[] {
    const root = this.goalsRoot();
    if (!existsSync(root)) return [];
    const records: GoalRecord[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = this.readRecord(entry.name);
      if (record) records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return records;
  }

  /** The single active goal, if any (most recent wins if the invariant broke). */
  findActive(): GoalRecord | null {
    const active = this.listRecords().filter(r => r.state === 'active');
    if (active.length === 0) return null;
    return active[active.length - 1];
  }

  readCheckpoints(id: string): GoalCheckpoint[] {
    const path = this.checkpointsPath(id);
    if (!existsSync(path)) return [];
    const out: GoalCheckpoint[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as GoalCheckpoint);
      } catch {
        // Skip malformed lines rather than corrupt the whole log.
      }
    }
    return out;
  }

  /**
   * Append a checkpoint. Idempotent: if a checkpoint with the same key already
   * exists, returns it unchanged (`appended: false`) without writing. Otherwise
   * assigns the next checkpoint number, appends one JSONL line, and stages the
   * durable files.
   */
  appendCheckpoint(draft: GoalCheckpointDraft): { appended: boolean; checkpoint: GoalCheckpoint } {
    this.ensureDir(draft.goalId);
    const existing = this.readCheckpoints(draft.goalId);
    const dup = existing.find(cp => cp.key === draft.key);
    if (dup) {
      return { appended: false, checkpoint: dup };
    }

    const checkpoint: GoalCheckpoint = { ...draft, checkpointNumber: existing.length + 1 };
    const path = this.checkpointsPath(draft.goalId);
    // Re-read then rewrite the full log so numbering stays consistent even if
    // the file was edited out-of-band; keeps the append atomic and idempotent.
    const lines = [...existing, checkpoint].map(cp => JSON.stringify(cp));
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
    this.maybeStage([path]);
    return { appended: true, checkpoint };
  }

  /** Write (overwrite) the retrospective. Idempotent. */
  writeRetrospective(id: string, markdown: string): string[] {
    this.ensureDir(id);
    const path = this.retrospectivePath(id);
    writeFileSync(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf-8');
    this.maybeStage([path]);
    return path ? [path] : [];
  }

  /** Force staging of a goal's durable directory (best-effort). */
  stage(id: string): void {
    this.maybeStage([this.goalDir(id)]);
  }
}
