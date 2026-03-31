export interface FeasibilityAssessment {
  verdict: 'go' | 'risky' | 'no-go';
  confidence: number; // 0.0 - 1.0
  concerns: string[];
  recommendation: string;
  alternative?: string;
}

export interface PlannedRole {
  key: string;
  description: string;
  model?: string;
  skills: string[];
  why: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  assignedTo: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
}

export interface Plan {
  scenario: string;
  feasibility: FeasibilityAssessment;
  rationale: string;
  roles: PlannedRole[];
  tasks: PlannedTask[];
  basedOnTemplate?: string;
}

export function isPlanApproved(plan: Plan): boolean {
  return plan.feasibility.verdict !== 'no-go';
}

export function planSummary(plan: Plan): string {
  const f = plan.feasibility;
  const icon = f.verdict === 'go' ? '✅' : f.verdict === 'risky' ? '⚠️' : '🛑';
  const pct = Math.round(f.confidence * 100);
  return `${icon} ${f.verdict.toUpperCase()} (${pct}%) — ${plan.roles.length} roles, ${plan.tasks.length} tasks`;
}
