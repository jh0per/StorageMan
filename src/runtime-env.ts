import { existsSync, readFileSync, statSync } from 'fs';
import { parse } from 'dotenv';

const ENV_PATH = '.env';

let lastLoadedMtimeMs = Number.NaN;
let managedKeys = new Set<string>();

function syncRuntimeEnv(): void {
  const hasEnvFile = existsSync(ENV_PATH);
  const nextMtimeMs = hasEnvFile ? statSync(ENV_PATH).mtimeMs : -1;

  if (nextMtimeMs === lastLoadedMtimeMs) {
    return;
  }

  const nextValues = hasEnvFile ? parse(readFileSync(ENV_PATH)) : {};

  for (const key of managedKeys) {
    if (!(key in nextValues)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextValues)) {
    process.env[key] = value;
  }

  managedKeys = new Set(Object.keys(nextValues));
  lastLoadedMtimeMs = nextMtimeMs;
}

export function getRuntimeEnv(name: string): string | undefined {
  syncRuntimeEnv();
  return process.env[name];
}
