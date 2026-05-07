import { execSync } from 'child_process';
import { API_KEY, API_URL, DB_ID, INTEGRATION_DIR, TIMEOUT_STARTUP } from './config.js';
import { sleep } from './time.js';

export interface DucklingContainerState {
  exitCode: number | null;
  raw: string;
  running: boolean;
  status: string;
}

function dockerCompose(command: string): string {
  return execSync(`docker compose ${command}`, {
    cwd: INTEGRATION_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString('utf8');
}

export function getDucklingLogs(tail = 400): string {
  return dockerCompose(
    `exec -T duckling sh -lc 'tail -n ${tail} /app/data/logs/sync.log 2>/dev/null || true'`,
  );
}

export function getDucklingComposeLogs(tail = 400): string {
  return dockerCompose(`logs --tail ${tail} duckling 2>/dev/null || true`);
}

export function getDucklingContainerState(): DucklingContainerState {
  try {
    const raw = execSync(
      "docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}' integration-duckling",
      {
        cwd: INTEGRATION_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
      .toString('utf8')
      .trim();

    const [status = 'unknown', runningRaw = 'false', exitCodeRaw = ''] = raw.split('|');
    const exitCode = exitCodeRaw === '' ? null : Number(exitCodeRaw);
    return {
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      raw,
      running: runningRaw === 'true',
      status,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      exitCode: null,
      raw,
      running: false,
      status: 'missing',
    };
  }
}

export function killDucklingHard(): void {
  dockerCompose('kill -s SIGKILL duckling');
}

export function startDuckling(): void {
  dockerCompose('up -d duckling');
}

export async function waitForDucklingReady(timeoutMs = TIMEOUT_STARTUP): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/health?db=${DB_ID}`, {
        headers: {
          Authorization: API_KEY,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }

  throw new Error(`Duckling did not become ready within ${timeoutMs}ms (${lastError})`);
}

export async function waitForDucklingLog(pattern: string, timeoutMs = 30000, tail = 800): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let logs = '';

  while (Date.now() < deadline) {
    logs = getDucklingLogs(tail);
    if (logs.includes(pattern)) {
      return logs;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for duckling log pattern: ${pattern}\n\nRecent logs:\n${logs}`);
}

export async function waitForDucklingExit(timeoutMs = TIMEOUT_STARTUP): Promise<DucklingContainerState> {
  const deadline = Date.now() + timeoutMs;
  let state = getDucklingContainerState();

  while (Date.now() < deadline) {
    state = getDucklingContainerState();
    if (!state.running) {
      return state;
    }
    await sleep(500);
  }

  throw new Error(`Duckling did not exit within ${timeoutMs}ms (${state.raw})`);
}
