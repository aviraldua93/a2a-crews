import { describe, expect, it } from 'bun:test';
import { loadPreset, listPresets } from '../src/templates';

describe('templates', () => {
  it('lists all 13 presets', () => {
    const presets = listPresets();
    expect(presets.length).toBe(13);
    expect(presets).toContain('feature');
    expect(presets).toContain('data-science');
    expect(presets).toContain('harness');
  });

  it('loads feature preset with correct structure', () => {
    const preset = loadPreset('feature');
    expect(preset.name).toBe('feature');
    expect(preset.roles.length).toBe(3);
    expect(preset.tasks.length).toBeGreaterThanOrEqual(3);
  });

  it('every preset has valid roles and tasks', () => {
    for (const name of listPresets()) {
      const preset = loadPreset(name);
      expect(preset.name).toBeTruthy();
      expect(preset.roles.length).toBeGreaterThan(0);
      expect(preset.tasks.length).toBeGreaterThan(0);

      // Every task assigned_to references a valid role
      const roleKeys = new Set(preset.roles.map(r => r.key));
      for (const task of preset.tasks) {
        expect(roleKeys.has(task.assigned_to)).toBe(true);
      }

      // Every dependency references a valid task
      const taskIds = new Set(preset.tasks.map(t => t.id));
      for (const task of preset.tasks) {
        for (const dep of task.depends_on) {
          expect(taskIds.has(dep)).toBe(true);
        }
      }
    }
  });
});
