import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Assessment {
  assessor: string;
  verdict: string;
  concerns: string[];
  confidence: number;
}

export interface FeasibilityResult {
  technical: Assessment;
  scope: Assessment;
  risk: Assessment;
  overall: {
    verdict: 'go' | 'risky' | 'no-go';
    confidence: number;
    concerns: string[];
    recommendation: string;
  };
}

// For now, run assessments locally (no spawned agents) using heuristic analysis
// This avoids the spawning complexity and gives instant results
export function assessFeasibility(scenario: string, projectDir: string): FeasibilityResult {
  const technical = assessTechnical(scenario, projectDir);
  const scope = assessScope(scenario, projectDir);
  const risk = assessRisk(scenario, projectDir);

  const avgConfidence = (technical.confidence + scope.confidence + risk.confidence) / 3;
  const allConcerns = [...technical.concerns, ...scope.concerns, ...risk.concerns];

  let verdict: 'go' | 'risky' | 'no-go';
  if (avgConfidence > 0.7 && !allConcerns.some(c => c.includes('BLOCKING'))) {
    verdict = 'go';
  } else if (avgConfidence > 0.3) {
    verdict = 'risky';
  } else {
    verdict = 'no-go';
  }

  return {
    technical,
    scope,
    risk,
    overall: {
      verdict,
      confidence: Math.round(avgConfidence * 100) / 100,
      concerns: allConcerns,
      recommendation: verdict === 'go'
        ? 'Proceed with the plan.'
        : verdict === 'risky'
        ? 'Consider reducing scope or addressing concerns first.'
        : 'Task is too complex or risky. Split into smaller pieces.',
    },
  };
}

function assessTechnical(scenario: string, projectDir: string): Assessment {
  const concerns: string[] = [];
  let confidence = 0.85;

  const hasPkg = existsSync(join(projectDir, 'package.json'));
  const hasTsConfig = existsSync(join(projectDir, 'tsconfig.json'));
  const hasPyProject = existsSync(join(projectDir, 'pyproject.toml'));
  const hasRequirements = existsSync(join(projectDir, 'requirements.txt'));

  if (!hasPkg && !hasPyProject && !hasRequirements) {
    concerns.push('No package manager config found — greenfield project');
    confidence -= 0.05;
  }

  if (hasPkg) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.type === 'module') {
        concerns.push('ESM project — ensure all code uses import/export');
      }
      const depCount = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
      if (depCount > 50) {
        concerns.push(`Large dependency tree (${depCount} deps) — more integration risk`);
        confidence -= 0.1;
      }
    } catch {}
  }

  // Check scenario complexity keywords
  const complexKeywords = ['migrate', 'rewrite', 'refactor entire', 'database schema', 'auth system', 'payment'];
  const matched = complexKeywords.filter(k => scenario.toLowerCase().includes(k));
  if (matched.length > 0) {
    concerns.push(`Complex scope detected: ${matched.join(', ')}`);
    confidence -= 0.15 * matched.length;
  }

  return {
    assessor: 'technical',
    verdict: confidence > 0.6 ? 'feasible' : confidence > 0.3 ? 'challenging' : 'infeasible',
    concerns,
    confidence: Math.max(0.1, Math.min(1, confidence)),
  };
}

function assessScope(scenario: string, projectDir: string): Assessment {
  const concerns: string[] = [];
  let confidence = 0.85;

  const wordCount = scenario.split(/\s+/).length;
  if (wordCount > 30) {
    concerns.push('Scenario is very detailed — may need phasing');
    confidence -= 0.1;
  }
  if (wordCount < 5) {
    concerns.push('Scenario is vague — agents may interpret differently');
    confidence -= 0.1;
  }

  const srcFiles = countSourceFiles(projectDir);
  if (srcFiles > 100) {
    concerns.push(`Large codebase (${srcFiles} files) — agents need more exploration time`);
    confidence -= 0.1;
  }

  // Check for "and" clauses suggesting multiple features
  const andCount = (scenario.match(/\band\b/gi) ?? []).length;
  if (andCount > 3) {
    concerns.push(`Multiple features requested (${andCount}+ "and" clauses) — consider splitting`);
    confidence -= 0.1;
  }

  return {
    assessor: 'scope',
    verdict: confidence > 0.6 ? 'right-sized' : confidence > 0.3 ? 'needs-reduction' : 'needs-phasing',
    concerns,
    confidence: Math.max(0.1, Math.min(1, confidence)),
  };
}

function assessRisk(scenario: string, projectDir: string): Assessment {
  const concerns: string[] = [];
  let confidence = 0.85;

  const hasTests = existsSync(join(projectDir, 'tests')) ||
    existsSync(join(projectDir, 'test')) ||
    existsSync(join(projectDir, '__tests__'));
  if (!hasTests) {
    concerns.push('No existing test directory — new tests will lack baseline');
  }

  const hasGit = existsSync(join(projectDir, '.git'));
  if (!hasGit) {
    concerns.push('Not a git repo — no rollback safety');
    confidence -= 0.1;
  }

  const securityKeywords = ['auth', 'login', 'password', 'token', 'secret', 'payment', 'credit card'];
  const secMatched = securityKeywords.filter(k => scenario.toLowerCase().includes(k));
  if (secMatched.length > 0) {
    concerns.push(`Security-sensitive scope: ${secMatched.join(', ')} — review carefully`);
    confidence -= 0.05;
  }

  return {
    assessor: 'risk',
    verdict: confidence > 0.7 ? 'low-risk' : confidence > 0.4 ? 'medium-risk' : 'high-risk',
    concerns,
    confidence: Math.max(0.1, Math.min(1, confidence)),
  };
}

function countSourceFiles(dir: string): number {
  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `git -C "${dir}" ls-files "*.ts" "*.js" "*.py" "*.tsx" "*.jsx" 2>nul`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return result.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
