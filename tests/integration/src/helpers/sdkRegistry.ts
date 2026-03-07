import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SDK_REGISTRY_URL, SDK_REGISTRY_VERSION } from './config.js';

interface RegistryScenario {
  packageType?: 'module' | 'commonjs';
  files: Record<string, string>;
  installPackages?: string[];
  commands: Array<{
    command: string;
    args: string[];
  }>;
}

function writeProjectFiles(rootDir: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(rootDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
}

function runCommand(rootDir: string, command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
}

export function hasRegistrySdkVersion(): boolean {
  return SDK_REGISTRY_VERSION.trim().length > 0;
}

export function runFreshRegistrySdkScenario(name: string, scenario: RegistryScenario): void {
  if (!hasRegistrySdkVersion()) {
    throw new Error('DUCKLING_TEST_SDK_REGISTRY_VERSION is required for registry SDK scenarios');
  }

  const rootDir = mkdtempSync(join(tmpdir(), 'duckling-sdk-registry-'));
  const cacheDir = join(rootDir, '.npm-cache');

  try {
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({
        name: `duckling-sdk-registry-${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
        private: true,
        type: scenario.packageType ?? 'module',
      }, null, 2),
    );

    writeProjectFiles(rootDir, scenario.files);

    runCommand(rootDir, 'npm', [
      'install',
      '--cache', cacheDir,
      '--registry', SDK_REGISTRY_URL,
      '--prefer-online',
      '--no-package-lock',
      '--no-audit',
      '--fund=false',
      `@chittihq/duckling@${SDK_REGISTRY_VERSION}`,
      ...(scenario.installPackages ?? []),
    ]);

    for (const step of scenario.commands) {
      runCommand(rootDir, step.command, step.args);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
