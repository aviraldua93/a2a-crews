import { execFile } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, symlinkSync, mkdirSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR = '.worktrees';

/** Sanitize agent name for use in branch/directory names. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Build the worktree directory path for an agent. */
export function worktreePath(projectDir: string, agentName: string): string {
  return join(projectDir, WORKTREE_DIR, `agent-${sanitizeName(agentName)}`);
}

/** Build the branch name for an agent worktree. */
function branchName(agentName: string): string {
  return `agent/${sanitizeName(agentName)}`;
}

/** Run a git command in the given directory. */
async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 });
}

/**
 * Create a git worktree for an agent.
 * Creates .worktrees/agent-{name} with a new branch agent/{name}.
 * Symlinks node_modules and bun.lock into the worktree for compatibility.
 * Returns the absolute path to the worktree.
 */
export async function createWorktree(projectDir: string, agentName: string): Promise<string> {
  const wtPath = worktreePath(projectDir, agentName);
  const branch = branchName(agentName);

  // Ensure the .worktrees parent directory exists
  mkdirSync(join(projectDir, WORKTREE_DIR), { recursive: true });

  // If worktree already exists, remove it first (idempotent)
  if (existsSync(wtPath)) {
    await removeWorktree(projectDir, agentName);
  }

  // Delete the branch if it already exists (leftover from a prior run)
  try {
    await git(projectDir, ['branch', '-D', branch]);
  } catch {
    // Branch doesn't exist — that's fine
  }

  // Create the worktree with a new branch off HEAD
  await git(projectDir, ['worktree', 'add', wtPath, '-b', branch]);

  // Symlink shared artifacts so agents don't need to reinstall
  const symlinks = ['node_modules', 'bun.lock', 'package-lock.json'];
  for (const name of symlinks) {
    const source = join(projectDir, name);
    const target = join(wtPath, name);
    if (existsSync(source) && !existsSync(target)) {
      try {
        // Use 'junction' on Windows for node_modules (directory), 'file' for files
        const isDir = (await import('fs')).statSync(source).isDirectory();
        symlinkSync(source, target, isDir ? 'junction' : 'file');
      } catch {
        // Symlink failures are non-fatal (permissions, etc.)
      }
    }
  }

  return resolve(wtPath);
}

/**
 * Merge an agent's worktree branch back into the current branch.
 * Returns true on success, false on merge conflict.
 */
export async function mergeWorktree(projectDir: string, agentName: string): Promise<boolean> {
  const branch = branchName(agentName);

  try {
    await git(projectDir, ['merge', branch, '--no-edit']);
    return true;
  } catch (err: unknown) {
    // Check if it's a merge conflict — git puts conflict info in stdout
    const errObj = err as { message?: string; stdout?: string; stderr?: string };
    const combined = [errObj.message, errObj.stdout, errObj.stderr].filter(Boolean).join(' ');

    if (combined.includes('CONFLICT') || combined.includes('Automatic merge failed')) {
      // Abort the failed merge to leave the repo in a clean state
      try {
        await git(projectDir, ['merge', '--abort']);
      } catch {
        // Already aborted or not in a merge state
      }
      return false;
    }
    throw err;
  }
}

/**
 * Remove an agent's worktree and clean up its branch.
 */
export async function removeWorktree(projectDir: string, agentName: string): Promise<void> {
  const wtPath = worktreePath(projectDir, agentName);
  const branch = branchName(agentName);

  // Remove the worktree (--force handles dirty worktrees)
  try {
    await git(projectDir, ['worktree', 'remove', wtPath, '--force']);
  } catch {
    // Worktree may not exist or already removed
  }

  // Delete the branch
  try {
    await git(projectDir, ['branch', '-D', branch]);
  } catch {
    // Branch may not exist
  }
}

/**
 * Prune orphaned worktree metadata.
 */
export async function pruneWorktrees(projectDir: string): Promise<void> {
  try {
    await git(projectDir, ['worktree', 'prune']);
  } catch {
    // Non-fatal — prune is best-effort
  }
}

/**
 * Clean up all a2a-crews worktrees in a project.
 * Used for error recovery to avoid leaving orphans.
 */
export async function cleanupAllWorktrees(projectDir: string): Promise<void> {
  try {
    const { stdout } = await git(projectDir, ['worktree', 'list', '--porcelain']);
    const worktreeLines = stdout.split('\n').filter(l => l.startsWith('worktree '));

    for (const line of worktreeLines) {
      const path = line.replace('worktree ', '').trim();
      // Only clean up our worktrees (those inside .worktrees/agent-*)
      if (path.includes(`${WORKTREE_DIR}`) && path.includes('agent-')) {
        const agentMatch = path.match(/agent-([a-zA-Z0-9_-]+)$/);
        if (agentMatch) {
          await removeWorktree(projectDir, agentMatch[1]);
        }
      }
    }
  } catch {
    // Best-effort cleanup
  }

  await pruneWorktrees(projectDir);
}
