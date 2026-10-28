import { readFileSync } from 'fs';

export interface DashboardHttpsOptions {
  cert: Buffer;
  key: Buffer;
}

/**
 * TLS for the dashboard itself: with both `TLS_CERT_FILE` and `TLS_KEY_FILE` (PEM files) set the
 * server listens on https, with neither it stays plain http. Setting only one is a mistake that
 * would silently serve http, so it fails at startup instead.
 */
export function loadHttpsOptions(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): DashboardHttpsOptions | undefined {
  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  if (!certFile && !keyFile) {
    return undefined;
  }
  if (!certFile || !keyFile) {
    throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE to serve https, or neither for http');
  }
  return { cert: readFile(certFile), key: readFile(keyFile) };
}
