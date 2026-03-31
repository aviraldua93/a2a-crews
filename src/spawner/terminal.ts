import { $ } from 'bun';
import { spawn } from 'child_process';

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
    case 'windows': {
      // Use child_process.spawn for reliable wt.exe invocation
      const wtPath = `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`;
      spawn(wtPath, [
        '-w', '0', 'new-tab', '--title', options.title,
        'pwsh', '-NoExit', '-Command',
        `Set-Location '${options.cwd}'; ${options.command}`
      ], { detached: true, stdio: 'ignore' }).unref();
      break;
    }

    case 'macos':
    case 'linux': {
      // tmux (must be in a tmux session)
      const sessionExists = await $`tmux has-session 2>/dev/null`.quiet().then(() => true).catch(() => false);
      if (sessionExists) {
        await $`tmux new-window -n ${options.title} "cd ${options.cwd} && ${options.command}"`.quiet();
      } else {
        // Fallback: run in background
        spawn('sh', ['-c', `cd '${options.cwd}' && ${options.command}`], { detached: true, stdio: 'ignore' }).unref();
      }
      break;
    }
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

  const platform = detectPlatform();
  let command: string;

  if (platform === 'windows') {
    // PowerShell reads file and passes to copilot
    command = `$p = Get-Content '${promptFile}' -Raw; copilot -p $p --yolo${modelFlag}`;
  } else {
    command = `copilot -p "$(cat '${promptFile}')" --yolo${modelFlag}`;
  }

  await spawnTab({
    title: `${config.name} (a2a-crews)`,
    command,
    cwd: config.cwd,
  });

  // Small delay between spawns to avoid terminal race
  await new Promise(resolve => setTimeout(resolve, 800));
}
