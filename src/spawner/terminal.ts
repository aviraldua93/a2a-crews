import { $ } from 'bun';

export type Platform = 'windows' | 'macos' | 'linux';

export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

export interface SpawnOptions {
  title: string;
  command: string;
  cwd: string;
}

export async function spawnTab(options: SpawnOptions): Promise<void> {
  const platform = detectPlatform();

  switch (platform) {
    case 'windows':
      // Windows Terminal
      await $`wt.exe -w 0 new-tab --title ${options.title} pwsh -Command "Set-Location '${options.cwd}'; ${options.command}"`.quiet();
      break;

    case 'macos':
    case 'linux':
      // tmux (must be in a tmux session)
      const sessionExists = await $`tmux has-session 2>/dev/null`.quiet().then(() => true).catch(() => false);
      if (sessionExists) {
        await $`tmux new-window -n ${options.title} "cd ${options.cwd} && ${options.command}"`.quiet();
      } else {
        // Fallback: run in background
        await $`cd ${options.cwd} && ${options.command} &`.quiet();
      }
      break;
  }
}

export async function spawnAgent(config: {
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  bridgeUrl: string;
}): Promise<void> {
  const modelFlag = config.model ? ` --model "${config.model}"` : '';

  // Write prompt to temp file to avoid quoting issues
  const promptFile = `${config.cwd}/.a2a-crews-prompt-${config.name}.txt`;
  await Bun.write(promptFile, config.prompt);

  const command = `copilot -p "$(cat '${promptFile}')" --yolo${modelFlag}`;

  await spawnTab({
    title: `${config.name} (a2a-crews)`,
    command,
    cwd: config.cwd,
  });

  // Small delay between spawns to avoid terminal race
  await new Promise(resolve => setTimeout(resolve, 800));
}
