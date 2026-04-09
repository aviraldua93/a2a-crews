import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import {
  createWorktree,
  mergeWorktree,
  removeWorktree,
  pruneWorktrees,
  cleanupAllWorktrees,
  worktreePath,
} from '../src/spawner/worktree';
import { generateAgentPrompt } from '../src/spawner/prompt';
import { Agent } from '../src/crew/agent';
import { Task } from '../src/crew/task';

// Helper: create a temporary git repo for testing
function createTempRepo(name: string): string {
  const base = join(process.cwd(), '.test-worktrees');
  const dir = join(base, name + '-' + Date.now());
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Create initial commit so we have a HEAD
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupTempRepos(): void {
  const base = join(process.cwd(), '.test-worktrees');
  if (existsSync(base)) {
    // Remove worktrees first to avoid git lock issues
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── worktreePath ──────────────────────────────────────────────────────

describe('worktreePath', () => {
  it('returns path under .worktrees directory', () => {
    const p = worktreePath('/projects/myapp', 'coder');
    expect(p).toContain('.worktrees');
    expect(p).toContain('agent-coder');
  });

  it('sanitizes special characters in agent name', () => {
    const p = worktreePath('/projects/myapp', 'my agent/v2');
    expect(p).toContain('agent-my_agent_v2');
    expect(p).not.toContain('/v2');
  });

  it('handles hyphens and underscores', () => {
    const p = worktreePath('/projects/myapp', 'code-reviewer_v2');
    expect(p).toContain('agent-code-reviewer_v2');
  });
});

// ── createWorktree ────────────────────────────────────────────────────

describe('createWorktree', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('create-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('creates a worktree directory', async () => {
    const path = await createWorktree(repoDir, 'architect');
    expect(existsSync(path)).toBe(true);
  });

  it('creates a branch for the agent', async () => {
    await createWorktree(repoDir, 'architect');
    const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf-8' });
    expect(branches).toContain('agent/architect');
  });

  it('returns an absolute path', async () => {
    const path = await createWorktree(repoDir, 'coder');
    // Absolute paths on Windows start with drive letter, on Unix with /
    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/i.test(path);
    expect(isAbsolute).toBe(true);
  });

  it('worktree has the same files as main', async () => {
    const path = await createWorktree(repoDir, 'tester');
    expect(existsSync(join(path, 'README.md'))).toBe(true);
  });

  it('symlinks node_modules if present', async () => {
    // Create a node_modules dir in the repo
    mkdirSync(join(repoDir, 'node_modules', 'fake-pkg'), { recursive: true });
    writeFileSync(join(repoDir, 'node_modules', 'fake-pkg', 'index.js'), 'module.exports = {}');

    const path = await createWorktree(repoDir, 'linker');
    const nmPath = join(path, 'node_modules');
    expect(existsSync(nmPath)).toBe(true);
  });

  it('symlinks bun.lock if present', async () => {
    writeFileSync(join(repoDir, 'bun.lock'), 'lockfile-content');
    execSync('git add bun.lock && git commit -m "add lock"', { cwd: repoDir, stdio: 'pipe' });

    const path = await createWorktree(repoDir, 'locker');
    // The bun.lock might be from git checkout or symlink — either is fine
    expect(existsSync(join(path, 'bun.lock'))).toBe(true);
  });

  it('is idempotent — recreates if worktree already exists', async () => {
    const path1 = await createWorktree(repoDir, 'idempotent');
    expect(existsSync(path1)).toBe(true);

    // Should not throw
    const path2 = await createWorktree(repoDir, 'idempotent');
    expect(existsSync(path2)).toBe(true);
    expect(path1).toBe(path2);
  });

  it('creates .worktrees parent directory', async () => {
    await createWorktree(repoDir, 'dircheck');
    expect(existsSync(join(repoDir, '.worktrees'))).toBe(true);
  });

  it('worktree is on the correct branch', async () => {
    const path = await createWorktree(repoDir, 'branchcheck');
    const branch = execSync('git branch --show-current', { cwd: path, encoding: 'utf-8' }).trim();
    expect(branch).toBe('agent/branchcheck');
  });
});

// ── mergeWorktree ─────────────────────────────────────────────────────

describe('mergeWorktree', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('merge-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('merges clean changes successfully', async () => {
    const path = await createWorktree(repoDir, 'merger');

    // Make a change in the worktree
    writeFileSync(join(path, 'new-file.txt'), 'hello from worktree');
    execSync('git add . && git commit -m "add file"', { cwd: path, stdio: 'pipe' });

    const result = await mergeWorktree(repoDir, 'merger');
    expect(result).toBe(true);

    // Verify the file exists in main repo after merge
    expect(existsSync(join(repoDir, 'new-file.txt'))).toBe(true);
  });

  it('returns false on merge conflict', async () => {
    const path = await createWorktree(repoDir, 'conflicted');

    // Modify same file in both main and worktree
    writeFileSync(join(repoDir, 'README.md'), '# Main changes\n');
    execSync('git add . && git commit -m "main change"', { cwd: repoDir, stdio: 'pipe' });

    writeFileSync(join(path, 'README.md'), '# Worktree changes\n');
    execSync('git add . && git commit -m "worktree change"', { cwd: path, stdio: 'pipe' });

    const result = await mergeWorktree(repoDir, 'conflicted');
    expect(result).toBe(false);

    // Repo should not be in a merge state (merge was aborted)
    const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8' });
    // The .worktrees directory may show as modified — that's expected
    // The key is that no conflict markers remain on tracked files
    const conflictFiles = status.split('\n').filter(l => l.startsWith('U') || l.startsWith('AA') || l.startsWith('DD'));
    expect(conflictFiles.length).toBe(0);
  });

  it('merges multiple new files', async () => {
    const path = await createWorktree(repoDir, 'multi');

    writeFileSync(join(path, 'file1.txt'), 'one');
    writeFileSync(join(path, 'file2.txt'), 'two');
    writeFileSync(join(path, 'file3.txt'), 'three');
    execSync('git add . && git commit -m "add three files"', { cwd: path, stdio: 'pipe' });

    const result = await mergeWorktree(repoDir, 'multi');
    expect(result).toBe(true);
    expect(existsSync(join(repoDir, 'file1.txt'))).toBe(true);
    expect(existsSync(join(repoDir, 'file2.txt'))).toBe(true);
    expect(existsSync(join(repoDir, 'file3.txt'))).toBe(true);
  });

  it('merges with no changes (no-op)', async () => {
    await createWorktree(repoDir, 'noop');
    // No changes in worktree — merge should be a no-op
    const result = await mergeWorktree(repoDir, 'noop');
    expect(result).toBe(true);
  });
});

// ── removeWorktree ────────────────────────────────────────────────────

describe('removeWorktree', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('remove-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('removes worktree directory', async () => {
    const path = await createWorktree(repoDir, 'removable');
    expect(existsSync(path)).toBe(true);

    await removeWorktree(repoDir, 'removable');
    expect(existsSync(path)).toBe(false);
  });

  it('removes the agent branch', async () => {
    await createWorktree(repoDir, 'branchclean');
    await removeWorktree(repoDir, 'branchclean');

    const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf-8' });
    expect(branches).not.toContain('agent/branchclean');
  });

  it('does not throw when worktree does not exist', async () => {
    // Should not throw
    await removeWorktree(repoDir, 'nonexistent');
  });

  it('handles dirty worktrees', async () => {
    const path = await createWorktree(repoDir, 'dirty');
    writeFileSync(join(path, 'uncommitted.txt'), 'dirty');

    // Should not throw — uses --force
    await removeWorktree(repoDir, 'dirty');
    expect(existsSync(path)).toBe(false);
  });
});

// ── pruneWorktrees ────────────────────────────────────────────────────

describe('pruneWorktrees', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('prune-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('runs without error on clean repo', async () => {
    await pruneWorktrees(repoDir);
    // Should not throw
  });

  it('runs without error after worktrees removed', async () => {
    await createWorktree(repoDir, 'prunable');
    await removeWorktree(repoDir, 'prunable');
    await pruneWorktrees(repoDir);
    // Should not throw
  });
});

// ── cleanupAllWorktrees ───────────────────────────────────────────────

describe('cleanupAllWorktrees', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('cleanup-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('cleans up all agent worktrees', async () => {
    const path1 = await createWorktree(repoDir, 'alpha');
    const path2 = await createWorktree(repoDir, 'beta');
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);

    await cleanupAllWorktrees(repoDir);

    expect(existsSync(path1)).toBe(false);
    expect(existsSync(path2)).toBe(false);
  });

  it('handles empty repo with no worktrees', async () => {
    // Should not throw
    await cleanupAllWorktrees(repoDir);
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────

describe('full worktree lifecycle', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('lifecycle-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('create → commit → merge → remove', async () => {
    // 1. Create worktree
    const path = await createWorktree(repoDir, 'lifecycle');
    expect(existsSync(path)).toBe(true);

    // 2. Make changes in the worktree
    writeFileSync(join(path, 'feature.ts'), 'export const feature = true;');
    execSync('git add . && git commit -m "implement feature"', { cwd: path, stdio: 'pipe' });

    // 3. Merge back
    const merged = await mergeWorktree(repoDir, 'lifecycle');
    expect(merged).toBe(true);
    expect(existsSync(join(repoDir, 'feature.ts'))).toBe(true);

    // 4. Remove
    await removeWorktree(repoDir, 'lifecycle');
    expect(existsSync(path)).toBe(false);

    // Branch should be gone
    const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf-8' });
    expect(branches).not.toContain('agent/lifecycle');
  });

  it('parallel worktrees for different agents', async () => {
    const pathA = await createWorktree(repoDir, 'agent-a');
    const pathB = await createWorktree(repoDir, 'agent-b');

    // Both exist simultaneously
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    // Make non-conflicting changes
    writeFileSync(join(pathA, 'file-a.txt'), 'from A');
    execSync('git add . && git commit -m "agent A work"', { cwd: pathA, stdio: 'pipe' });

    writeFileSync(join(pathB, 'file-b.txt'), 'from B');
    execSync('git add . && git commit -m "agent B work"', { cwd: pathB, stdio: 'pipe' });

    // Merge both
    expect(await mergeWorktree(repoDir, 'agent-a')).toBe(true);
    expect(await mergeWorktree(repoDir, 'agent-b')).toBe(true);

    // Both files present in main
    expect(existsSync(join(repoDir, 'file-a.txt'))).toBe(true);
    expect(existsSync(join(repoDir, 'file-b.txt'))).toBe(true);

    // Cleanup
    await removeWorktree(repoDir, 'agent-a');
    await removeWorktree(repoDir, 'agent-b');
  });

  it('recreate after failed merge', async () => {
    // Create and cause conflict
    const path1 = await createWorktree(repoDir, 'retry');
    writeFileSync(join(repoDir, 'README.md'), '# Changed in main\n');
    execSync('git add . && git commit -m "main"', { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(path1, 'README.md'), '# Changed in worktree\n');
    execSync('git add . && git commit -m "wt"', { cwd: path1, stdio: 'pipe' });

    // Merge fails
    expect(await mergeWorktree(repoDir, 'retry')).toBe(false);

    // Remove old worktree
    await removeWorktree(repoDir, 'retry');

    // Recreate and try again with non-conflicting change
    const path2 = await createWorktree(repoDir, 'retry');
    writeFileSync(join(path2, 'non-conflict.txt'), 'safe');
    execSync('git add . && git commit -m "safe change"', { cwd: path2, stdio: 'pipe' });

    expect(await mergeWorktree(repoDir, 'retry')).toBe(true);
    expect(existsSync(join(repoDir, 'non-conflict.txt'))).toBe(true);

    await removeWorktree(repoDir, 'retry');
  });
});

// ── Prompt integration ────────────────────────────────────────────────

describe('prompt worktree integration', () => {
  it('includes worktree note when worktreePath is set', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder' })];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/projects/app',
      worktreePath: '/projects/app/.worktrees/agent-coder',
    });

    expect(prompt).toContain('WORKTREE ISOLATION');
    expect(prompt).toContain('.worktrees/agent-coder');
    expect(prompt).toContain('isolated to your branch');
  });

  it('uses worktreePath as PROJECT in prompt', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder' })];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/projects/app',
      worktreePath: '/projects/app/.worktrees/agent-coder',
    });

    expect(prompt).toContain('PROJECT: /projects/app/.worktrees/agent-coder');
  });

  it('does not include worktree note when worktreePath is not set', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder' })];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/projects/app',
    });

    expect(prompt).not.toContain('WORKTREE ISOLATION');
    expect(prompt).not.toContain('isolated to your branch');
    expect(prompt).toContain('PROJECT: /projects/app');
  });

  it('does not include worktree note when worktreePath is undefined', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder' })];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/projects/app',
      worktreePath: undefined,
    });

    expect(prompt).not.toContain('WORKTREE ISOLATION');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────

describe('edge cases', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo('edge-test');
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it('handles agent names with spaces', async () => {
    const path = await createWorktree(repoDir, 'my agent');
    expect(existsSync(path)).toBe(true);
    await removeWorktree(repoDir, 'my agent');
  });

  it('handles agent names with dots', async () => {
    const path = await createWorktree(repoDir, 'v2.0');
    expect(existsSync(path)).toBe(true);
    await removeWorktree(repoDir, 'v2.0');
  });

  it('multiple create/remove cycles on same name', async () => {
    for (let i = 0; i < 3; i++) {
      const path = await createWorktree(repoDir, 'cycler');
      expect(existsSync(path)).toBe(true);
      await removeWorktree(repoDir, 'cycler');
      expect(existsSync(path)).toBe(false);
    }
  });
});
