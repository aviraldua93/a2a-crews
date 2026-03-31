import { describe, expect, it } from 'bun:test';
import { assessFeasibility, type FeasibilityResult } from '../src/planner/assessor';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-assess-'));
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe('assessFeasibility', () => {
  it('greenfield project (no package.json) returns go', () => {
    const dir = makeTempDir();
    // Init git so risk assessor doesn't penalize
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    const result = assessFeasibility('Build a REST API with tests', dir);

    expect(result.overall.verdict).toBe('go');
    expect(result.technical.concerns.some(c => c.includes('greenfield'))).toBe(true);
    expect(result.overall.confidence).toBeGreaterThan(0.5);

    cleanup(dir);
  });

  it('complex scenario with many keywords lowers confidence', () => {
    const dir = makeTempDir();
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    const scenario = 'Migrate the database schema and rewrite the auth system and add payment processing';
    const result = assessFeasibility(scenario, dir);

    expect(result.technical.confidence).toBeLessThan(0.5);
    expect(result.technical.concerns.some(c => c.includes('Complex scope'))).toBe(true);
    // With 3 complexity keywords, overall should be risky or no-go
    expect(['risky', 'no-go']).toContain(result.overall.verdict);

    cleanup(dir);
  });

  it('security-sensitive scenario is flagged', () => {
    const dir = makeTempDir();
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    const result = assessFeasibility('Add login and password reset with token validation', dir);

    expect(result.risk.concerns.some(c => c.includes('Security-sensitive'))).toBe(true);
    expect(result.risk.concerns.some(c => c.includes('login'))).toBe(true);
    expect(result.risk.concerns.some(c => c.includes('password'))).toBe(true);
    expect(result.risk.concerns.some(c => c.includes('token'))).toBe(true);

    cleanup(dir);
  });

  it('vague scenario raises concern', () => {
    const dir = makeTempDir();
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    const result = assessFeasibility('Fix bug', dir);

    expect(result.scope.concerns.some(c => c.includes('vague'))).toBe(true);

    cleanup(dir);
  });

  it('large project simulation raises concerns about exploration time', () => {
    const dir = makeTempDir();
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    // Create 101+ tracked files to simulate a large project
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 105; i++) {
      writeFileSync(join(srcDir, `file${i}.ts`), `// file ${i}`);
    }
    try {
      require('child_process').execSync('git add .', { cwd: dir, stdio: 'ignore' });
    } catch {}

    const result = assessFeasibility('Build a feature for the project', dir);

    expect(result.scope.concerns.some(c => c.includes('Large codebase'))).toBe(true);

    cleanup(dir);
  });

  it('overall structure has all three assessors', () => {
    const dir = makeTempDir();
    const result = assessFeasibility('Build something', dir);

    expect(result.technical.assessor).toBe('technical');
    expect(result.scope.assessor).toBe('scope');
    expect(result.risk.assessor).toBe('risk');
    expect(result.overall).toBeDefined();
    expect(['go', 'risky', 'no-go']).toContain(result.overall.verdict);
    expect(result.overall.confidence).toBeGreaterThanOrEqual(0);
    expect(result.overall.confidence).toBeLessThanOrEqual(1);
    expect(result.overall.recommendation).toBeTruthy();

    cleanup(dir);
  });

  it('project with many dependencies flags integration risk', () => {
    const dir = makeTempDir();
    try {
      require('child_process').execSync('git init', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'tests'));
    } catch {}

    // Create a package.json with 51+ deps
    const deps: Record<string, string> = {};
    for (let i = 0; i < 55; i++) {
      deps[`pkg-${i}`] = '1.0.0';
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: deps,
    }));

    const result = assessFeasibility('Build a feature', dir);

    expect(result.technical.concerns.some(c => c.includes('Large dependency tree'))).toBe(true);

    cleanup(dir);
  });
});
