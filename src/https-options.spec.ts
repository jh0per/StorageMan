import { loadHttpsOptions } from './https-options';

describe('loadHttpsOptions', () => {
  const readFile = (path: string) => Buffer.from(`contents of ${path}`);

  it('serves plain http when no TLS files are set', () => {
    expect(loadHttpsOptions({}, readFile)).toBeUndefined();
    expect(loadHttpsOptions({ TLS_CERT_FILE: ' ', TLS_KEY_FILE: '' }, readFile)).toBeUndefined();
  });

  it('reads the certificate and key when both are set', () => {
    const options = loadHttpsOptions(
      { TLS_CERT_FILE: '/etc/tls/cert.pem', TLS_KEY_FILE: '/etc/tls/key.pem' },
      readFile,
    );

    expect(options?.cert.toString()).toBe('contents of /etc/tls/cert.pem');
    expect(options?.key.toString()).toBe('contents of /etc/tls/key.pem');
  });

  it('refuses to start with only one of the two', () => {
    expect(() => loadHttpsOptions({ TLS_CERT_FILE: '/etc/tls/cert.pem' }, readFile)).toThrow(
      'Set both TLS_CERT_FILE and TLS_KEY_FILE',
    );
    expect(() => loadHttpsOptions({ TLS_KEY_FILE: '/etc/tls/key.pem' }, readFile)).toThrow(
      'Set both TLS_CERT_FILE and TLS_KEY_FILE',
    );
  });
});
