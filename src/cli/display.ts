export function printHeader(title: string): void {
  console.log(`\n  ╔${'═'.repeat(46)}╗`);
  console.log(`  ║  ${title.padEnd(43)}║`);
  console.log(`  ╚${'═'.repeat(46)}╝\n`);
}

export function printRoles(roles: { key: string; description: string }[]): void {
  console.log('  ROLES');
  for (const r of roles) {
    console.log(`    ${r.key}: ${r.description}`);
  }
  console.log();
}

export function printTasks(tasks: { id: string; title: string; assignedTo: string; dependsOn: string[]; status: string }[]): void {
  console.log('  TASKS');
  for (const t of tasks) {
    const icon = t.status === 'completed' ? '✅' : t.status === 'working' ? '🔄' : t.status === 'blocked' ? '🚫' : '⏳';
    const deps = t.dependsOn.length > 0 ? ` (← ${t.dependsOn.join(', ')})` : '';
    console.log(`    ${icon} ${t.id} → ${t.assignedTo} [${t.status}]${deps}`);
    console.log(`       ${t.title}`);
  }
  console.log();
}

export function printSummary(totalTime: number, waves: number, tasksCompleted: number, totalTasks: number): void {
  const min = Math.floor(totalTime / 60);
  const sec = Math.round(totalTime % 60);
  console.log(`  ╔${'═'.repeat(46)}╗`);
  console.log(`  ║  EXECUTION SUMMARY${' '.repeat(27)}║`);
  console.log(`  ╚${'═'.repeat(46)}╝`);
  console.log(`  Total time: ${min}m ${sec}s`);
  console.log(`  Waves: ${waves}`);
  console.log(`  Tasks: ${tasksCompleted}/${totalTasks}`);
  console.log();
}
