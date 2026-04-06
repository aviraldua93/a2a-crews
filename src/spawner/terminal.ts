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
      // Write a launcher script to avoid argument splitting in wt.exe
      const launcherFile = `${options.cwd}/.a2a-crews-launch-${options.title.replace(/[^a-zA-Z0-9-]/g, '_')}.ps1`;
      const cwd = options.cwd.replace(/\//g, '\\');
      const script = `Set-Location '${cwd}'\n${options.command}`;
      await Bun.write(launcherFile, script);

      const wtPath = `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`;
      spawn(wtPath, [
        '-w', '0', 'new-tab', '--title', options.title,
        'pwsh', '-NoExit', '-File', launcherFile.replace(/\//g, '\\')
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
  taskId?: string;
}): Promise<void> {
  const platform = detectPlatform();
  const modelFlag = config.model ? ` --model "${config.model}"` : '';

  // Use taskId in filenames to avoid EBUSY race when multiple tasks share the same role (#22)
  const uniqueSuffix = config.taskId ? config.taskId.slice(0, 8) : crypto.randomUUID().slice(0, 8);
  const fileBase = `${config.name}-${uniqueSuffix}`;

  // Write prompt to temp file to avoid quoting issues
  const promptFile = `${config.cwd}/.a2a-crews-prompt-${fileBase}.txt`.replace(/\//g, platform === 'windows' ? '\\' : '/');
  await Bun.write(promptFile, config.prompt);

  // Build post-completion bridge notification (JSON-RPC primary, REST fallback)
  const bridgeNotify = config.taskId && config.bridgeUrl
    ? platform === 'windows'
      ? `; try { Invoke-RestMethod -Uri '${config.bridgeUrl}/a2a' -Method POST -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"${config.taskId}-exit","role":"agent","parts":[{"kind":"text","text":"Agent completed"}],"metadata":{"taskId":"${config.taskId}","status":"completed"}}}}' -ErrorAction SilentlyContinue; Invoke-RestMethod -Uri '${config.bridgeUrl}/tasks/${config.taskId}' -Method PATCH -ContentType 'application/json' -Body '{"status":"completed","result":"Agent completed"}' -ErrorAction SilentlyContinue } catch {}`
      : `; curl -s -X POST '${config.bridgeUrl}/a2a' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"${config.taskId}-exit","role":"agent","parts":[{"kind":"text","text":"Agent completed"}],"metadata":{"taskId":"${config.taskId}","status":"completed"}}}}' 2>/dev/null; curl -s -X PATCH '${config.bridgeUrl}/tasks/${config.taskId}' -H 'Content-Type: application/json' -d '{"status":"completed","result":"Agent completed"}' 2>/dev/null || true`
    : '';

  let command: string;

  if (platform === 'windows') {
    command = `$p = Get-Content '${promptFile}' -Raw; copilot -p $p --yolo${modelFlag}${bridgeNotify}`;
  } else {
    command = `copilot -p "$(cat '${promptFile}')" --yolo${modelFlag}${bridgeNotify}`;
  }

  await spawnTab({
    title: `${fileBase} (a2a-crews)`,
    command,
    cwd: config.cwd,
  });

  // Small delay between spawns to avoid terminal race
  await new Promise(resolve => setTimeout(resolve, 800));
}
