import { readFileSync } from 'fs';
import { join } from 'path';

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

const PRESETS_DIR = join(import.meta.dir, 'presets');

export function loadPreset(name: string): Preset {
  const filePath = join(PRESETS_DIR, `${name}.json`);
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Preset;
}

export function listPresets(): string[] {
  const { readdirSync } = require('fs');
  return readdirSync(PRESETS_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => f.replace('.json', ''));
}
