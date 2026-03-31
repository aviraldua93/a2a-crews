export interface PresetRole {
  key: string;
  description: string;
  model: string | null;
  allowed_tools: string[];
}

export interface PresetTask {
  id: string;
  title: string;
  assigned_to: string;
  depends_on: string[];
}

export interface Preset {
  name: string;
  description: string;
  roles: PresetRole[];
  tasks: PresetTask[];
}

// Import presets directly so they're embedded in compiled binary
import audit from './presets/audit.json';
import bugfix from './presets/bugfix.json';
import dataPipeline from './presets/data-pipeline.json';
import dataScience from './presets/data-science.json';
import docReview from './presets/doc-review.json';
import feature from './presets/feature.json';
import fullstack from './presets/fullstack.json';
import harness from './presets/harness.json';
import mlExperiment from './presets/ml-experiment.json';
import refactor from './presets/refactor.json';
import research from './presets/research.json';
import ship from './presets/ship.json';
import sprint from './presets/sprint.json';

const PRESETS: Record<string, Preset> = {
  audit: audit as Preset,
  bugfix: bugfix as Preset,
  'data-pipeline': dataPipeline as Preset,
  'data-science': dataScience as Preset,
  'doc-review': docReview as Preset,
  feature: feature as Preset,
  fullstack: fullstack as Preset,
  harness: harness as Preset,
  'ml-experiment': mlExperiment as Preset,
  refactor: refactor as Preset,
  research: research as Preset,
  ship: ship as Preset,
  sprint: sprint as Preset,
};

export function loadPreset(name: string): Preset {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown preset: ${name}. Available: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

export function listPresets(): string[] {
  return Object.keys(PRESETS).sort();
}
