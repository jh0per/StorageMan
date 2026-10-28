import { displayNodeHost, nodeBaseUrl, parseNodeEndpoint } from './node-endpoint';
import { NodeRequestError } from './node-request';

describe('parseNodeEndpoint', () => {
  it.each([
    ['192.168.1.5:14002', 'http://192.168.1.5:14002'],
    ['  node.example:9980  ', 'http://node.example:9980'],
    ['http://192.168.1.5:14002', 'http://192.168.1.5:14002'],
    ['http://192.168.1.5:14002/', 'http://192.168.1.5:14002'],
    ['https://storj.example:14002', 'https://storj.example:14002'],
    ['HTTPS://Sia.Example:443/', 'https://Sia.Example:443'],
    ['[fd00::30]:14002', 'http://[fd00::30]:14002'],
    ['https://[fe80::1]:9980', 'https://[fe80::1]:9980'],
    ['[::ffff:192.0.2.1]:9980', 'http://[::ffff:192.0.2.1]:9980'],
    ['[::ffff:0.0.0.0]:9980', 'http://[::ffff:0.0.0.0]:9980'],
    ['[0001:0db8::0010]:9980', 'http://[0001:0db8::0010]:9980'],
    ['my_node-1.lan:65535', 'http://my_node-1.lan:65535'],
    ['0.0.0.0:9980', 'http://0.0.0.0:9980'],
    ['255.255.255.255:9980', 'http://255.255.255.255:9980'],
    ['123node.example:9980', 'http://123node.example:9980'],
    ['node.123abc:9980', 'http://node.123abc:9980'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example:443'],
  ])('%s -> %s', (raw, baseUrl) => {
    expect(parseNodeEndpoint(raw)?.baseUrl).toBe(baseUrl);
  });

  it.each([
    ['https://node.example', 'https://node.example:443'],
    ['https://node.example/', 'https://node.example:443'],
    ['HTTPS://Node.Example', 'https://Node.Example:443'],
    ['http://node.example', 'http://node.example:80'],
    ['http://192.0.2.7/', 'http://192.0.2.7:80'],
    ['https://[fd00::5]', 'https://[fd00::5]:443'],
    ['http://[fd00::5]/', 'http://[fd00::5]:80'],
    ['https://node.example:8443', 'https://node.example:8443'],
  ])("a scheme without a port means the scheme's port: %s -> %s", (raw, baseUrl) => {
    expect(parseNodeEndpoint(raw)?.baseUrl).toBe(baseUrl);
  });

  it('keeps scheme, host and port apart', () => {
    expect(parseNodeEndpoint('https://[fd00::40]:9980')).toEqual({
      scheme: 'https',
      host: 'fd00::40',
      port: 9980,
      baseUrl: 'https://[fd00::40]:9980',
    });
    expect(parseNodeEndpoint('https://storj.example')).toEqual({
      scheme: 'https',
      host: 'storj.example',
      port: 443,
      baseUrl: 'https://storj.example:443',
    });
  });

  it.each([
    '',
    'node.example',
    'node.example/',
    '192.0.2.7',
    'https://',
    'https:///',
    'https://node.example:',
    'https://node.example/api',
    'https://user@node.example',
    'https://fe80::1',
    'https://[fe80::1]:',
    'https://[fe80::1]x',
    'ftp://node.example:21',
    'ftp://node.example',
    'fe80::1',
    'fe80::1:9980',
    '[fe80::1]',
    '[fe80::1]9980',
    '[not-ipv6]:9980',
    'node.example:0',
    'node.example:65536',
    'node.example:port',
    'node.example:9980/api',
    'user:pass@node.example:9980',
    'https://user:pass@node.example:9980',
    'node example:9980',
    '-node.example:9980',
  ])('rejects %p', (raw) => {
    expect(parseNodeEndpoint(raw)).toBeUndefined();
  });

  it.each([
    // Rejected by the WHATWG URL parser that fetch and the browser use.
    '256.1.1.1:9980',
    'https://192.168.1.300',
    'http://192.168.1.300/',
    'https://1.2.3.4.5',
    'host.123:9980',
    'https://example.123',
    'node.0x1f:9980',
    // Read by it as another IPv4 address: 8.0.0.1, 127.0.0.1, 1.2.0.3, 255.255.255.255.
    '010.0.0.1:9980',
    '0x7f.1:9980',
    'https://1.2.3',
    '4294967295:9980',
    // Written back in another form of the same address (192.168.1.5): any difference is refused.
    '192.168.1.05:9980',
    // An IPv6 literal whose dotted IPv4 tail has a leading zero: the parser rejects it.
    '[::ffff:192.168.1.05]:9980',
    'https://[64:ff9b::00.1.2.3]',
  ])('rejects %p, which fetch would not request as written', (raw) => {
    expect(parseNodeEndpoint(raw)).toBeUndefined();
  });
});

describe('nodeBaseUrl', () => {
  it('builds http for a bare host:port and keeps an explicit https', () => {
    expect(nodeBaseUrl('10.0.0.5:14002')).toBe('http://10.0.0.5:14002');
    expect(nodeBaseUrl('https://10.0.0.5:14002/')).toBe('https://10.0.0.5:14002');
    expect(nodeBaseUrl('[fd00::5]:9980')).toBe('http://[fd00::5]:9980');
  });

  it("gives a scheme without a port the scheme's default port", () => {
    expect(nodeBaseUrl('https://node.example')).toBe('https://node.example:443');
    expect(nodeBaseUrl('http://node.example/')).toBe('http://node.example:80');
  });

  it.each([
    'node.example',
    'node.example:9980/api',
    'user:secret@node.example:9980',
    'https://node.example/api',
    'https://secret@node.example',
    'https://user:secret@node.example:443',
    'ftp://node:21',
    'https://node.example.123',
    '',
  ])('rejects %p as an invalid endpoint without echoing it', (raw) => {
    let thrown: unknown;
    try {
      nodeBaseUrl(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NodeRequestError);
    expect((thrown as NodeRequestError).kind).toBe('invalid_endpoint');
    expect((thrown as NodeRequestError).message).not.toContain('secret');
    expect((thrown as NodeRequestError).message).not.toContain('node.example');
  });

  it('keeps the help text for a bare host without a port', () => {
    expect(() => nodeBaseUrl('node.example')).toThrow(
      'Invalid node address: use host:port, https://host:port or [IPv6]:port',
    );
  });
});

describe('displayNodeHost', () => {
  it('shows a valid address as configured', () => {
    expect(displayNodeHost('https://[fd00::5]:9980')).toBe('https://[fd00::5]:9980');
    expect(displayNodeHost(' 10.0.0.5:14002 ')).toBe(' 10.0.0.5:14002 ');
  });

  it.each([
    ['user:secret@node.example:9980', '***@node.example:9980'],
    ['https://user:se@cret@node.example:443', 'https://***@node.example:443'],
    ['http://secret@node.example:9980/x', 'http://***@node.example:9980/x'],
  ])('masks user credentials in %p', (raw, shown) => {
    expect(displayNodeHost(raw)).toBe(shown);
  });
});
