import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  discoverSiaNodes,
  mergeDiscoveredNodes,
  parseDiscoveryRoots,
  readHostdHttpConfig,
  SiaNodeConfig,
} from './sia-discovery';

/** Permissions do not stop root, so the chmod cases only run as another user. */
const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'storageman-sia-discovery-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** `<root>/<name>/hostd.yml` with `contents`; returns the root. */
function hostdDirectory(root: string, name: string, contents?: string): string {
  mkdirSync(join(root, name), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(root, name, 'hostd.yml'), contents);
  }
  return root;
}

function httpSection(password: string, address = ':9980'): string {
  return `http:\n  address: ${address}\n  password: ${password}\n`;
}

describe('parseDiscoveryRoots', () => {
  it.each([undefined, '', '  ', ' , ,'])('%p is no root', (raw) => {
    expect(parseDiscoveryRoots(raw)).toEqual([]);
  });

  it('splits on commas, trims and drops repeats', () => {
    expect(parseDiscoveryRoots(' /srv/sia, /var/lib/sia,,/srv/sia ,/srv/sia')).toEqual([
      '/srv/sia',
      '/var/lib/sia',
    ]);
  });
});

describe('readHostdHttpConfig', () => {
  it('reads unquoted values', () => {
    expect(readHostdHttpConfig(httpSection('change-me'))).toEqual({
      address: ':9980',
      password: 'change-me',
    });
  });

  it('strips double and single quotes', () => {
    const contents = 'http:\n  address: "0.0.0.0:9980"\n  password: \'change-me\'\n';
    expect(readHostdHttpConfig(contents)).toEqual({
      address: '0.0.0.0:9980',
      password: 'change-me',
    });
  });

  it.each([
    ['"change\\"me\\\\x"', 'change"me\\x'],
    ['"tab\\there"', 'tab\there'],
    ['"\\x41\\u00e9\\U0001F600"', 'A\u00e9\u{1F600}'],
    ['"\\N\\_\\L\\P"', '\u0085\u00a0\u2028\u2029'],
    ['"keep\\qas written"', 'keep\\qas written'],
    ["'it''s'", "it's"],
    ["'no \\escapes'", 'no \\escapes'],
    ['""', ''],
  ])('reads the quoted value %s as YAML does', (written, value) => {
    expect(readHostdHttpConfig(`http:\n  password: ${written}\n`).password).toBe(value);
  });

  it('skips comments, blank lines and trailing comments', () => {
    const contents = [
      '# hostd config',
      '',
      'http: # the API',
      '',
      '  # address: :1111',
      '  address: :9980 # published as sia_9980',
      '   ',
      '  password: "change # me" # quoted, so the first # is the password',
      '',
    ].join('\n');
    expect(readHostdHttpConfig(contents)).toEqual({ address: ':9980', password: 'change # me' });
  });

  it.each([
    ['at the start of the line, first in the section', 'http:\n# note\n  password: change-me\n'],
    [
      'at the start of the line, between keys',
      'http:\n  address: :9980\n# note\n  password: change-me\n',
    ],
    [
      'indented deeper than the keys, first in the section',
      'http:\n    # note\n  password: change-me\n',
    ],
  ])('reads on past a comment line %s', (_where, contents) => {
    expect(readHostdHttpConfig(contents).password).toBe('change-me');
  });

  it('keeps a # that does not start a comment', () => {
    expect(readHostdHttpConfig('http:\n  password: change#me\n').password).toBe('change#me');
    expect(readHostdHttpConfig('http:\n  password: # nothing\n').password).toBe('');
  });

  it('reads CRLF line ends and a byte order mark', () => {
    expect(
      readHostdHttpConfig('\uFEFFhttp:\r\n  address: :9980\r\n  password: change-me\r\n'),
    ).toEqual({
      address: ':9980',
      password: 'change-me',
    });
  });

  it('ignores the address and password of other sections, top-level keys and nested keys', () => {
    const contents = [
      'password: top-level',
      'syncer:',
      '  address: :9981',
      '  password: syncer-change-me',
      'http:',
      '  tls:',
      '    address: :1111',
      '    password: nested-change-me',
      '  address: :9980',
      '  password: change-me',
      'rhp4:',
      '  address: :9984',
      '  password: rhp4-change-me',
      'consensus:',
      '  network: mainnet',
    ].join('\n');
    expect(readHostdHttpConfig(contents)).toEqual({ address: ':9980', password: 'change-me' });
  });

  it('takes the first value of a key', () => {
    const contents = 'http:\n  password: first\n  address: :9980\n  password: second\n';
    expect(readHostdHttpConfig(contents).password).toBe('first');
  });

  it('reads the http section wherever it is, and only its own lines', () => {
    const contents =
      'syncer:\n  address: :9981\nhttp:\n  password: change-me\nlog:\n  address: x\n';
    expect(readHostdHttpConfig(contents)).toEqual({ password: 'change-me' });
  });

  it('finds nothing without an http section', () => {
    expect(readHostdHttpConfig('syncer:\n  address: :9981\n  password: change-me\n')).toEqual({});
    expect(readHostdHttpConfig('')).toEqual({});
    expect(readHostdHttpConfig('http: {}\n  address: :9980\n')).toEqual({});
  });

  it('leaves a missing password undefined', () => {
    expect(readHostdHttpConfig('http:\n  address: :9980\n')).toEqual({ address: ':9980' });
  });
});

describe('discoverSiaNodes', () => {
  it('reads sia_<digits> directories and symbolic links in numeric order', () => {
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_10000', httpSection('change-me-c'));
    hostdDirectory(root, 'sia_9981', httpSection('change-me-b'));
    hostdDirectory(root, 'sia_9980', httpSection('change-me-a'));
    hostdDirectory(root, 'sia_100', httpSection('change-me-0'));
    hostdDirectory(root, 'sia_200', httpSection('change-me-00'));
    // Leading zeros do not count: 0101 is 101, after 100 and before 200, though it has more digits.
    hostdDirectory(root, 'sia_0101', httpSection('change-me-01'));
    // A node kept elsewhere and linked into the root.
    hostdDirectory(join(sandbox, 'elsewhere'), 'node-d', httpSection('change-me-d'));
    symlinkSync(join(sandbox, 'elsewhere', 'node-d'), join(root, 'sia_9982'), 'dir');
    // Not node directories.
    writeFileSync(join(root, 'sia_9983'), httpSection('file'));
    for (const name of ['sia_', 'sia_abc', 'sia_9984x', 'other_9985', 'SIA_9986', 'xsia_9987']) {
      hostdDirectory(root, name, httpSection('not-a-node'));
    }

    expect(discoverSiaNodes([root], '127.0.0.1')).toEqual([
      { host: '127.0.0.1:100', username: '', password: 'change-me-0' },
      { host: '127.0.0.1:101', username: '', password: 'change-me-01' },
      { host: '127.0.0.1:200', username: '', password: 'change-me-00' },
      { host: '127.0.0.1:9980', username: '', password: 'change-me-a' },
      { host: '127.0.0.1:9981', username: '', password: 'change-me-b' },
      { host: '127.0.0.1:9982', username: '', password: 'change-me-d' },
      { host: '127.0.0.1:10000', username: '', password: 'change-me-c' },
    ]);
  });

  it('uses the port in the name, not the one hostd listens on inside', () => {
    const root = hostdDirectory(
      join(sandbox, 'root'),
      'sia_19980',
      httpSection('change-me', ':9980'),
    );
    expect(discoverSiaNodes([root], '127.0.0.1')).toEqual([
      { host: '127.0.0.1:19980', username: '', password: 'change-me' },
    ]);
  });

  it('falls back to the port of http.address when the name holds no port', () => {
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_0', httpSection('change-me-a', ':9990'));
    hostdDirectory(root, 'sia_70000', httpSection('change-me-b', '[::]:9991'));
    hostdDirectory(root, 'sia_99999999999999999999999', httpSection('change-me-c', '0.0.0.0:9992'));

    expect(discoverSiaNodes([root], '127.0.0.1').map((node) => node.host)).toEqual([
      '127.0.0.1:9990',
      '127.0.0.1:9991',
      '127.0.0.1:9992',
    ]);
  });

  it('skips a node without any port', () => {
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_0', httpSection('no-address').replace(/ {2}address.*\n/, ''));
    hostdDirectory(root, 'sia_65536', httpSection('no-port', 'localhost'));
    hostdDirectory(root, 'sia_70000', httpSection('port-too-big', ':70000'));
    hostdDirectory(root, 'sia_00000', httpSection('port-zero', ':0'));
    hostdDirectory(root, 'sia_9980', httpSection('change-me'));

    expect(discoverSiaNodes([root], '127.0.0.1')).toEqual([
      { host: '127.0.0.1:9980', username: '', password: 'change-me' },
    ]);
  });

  it('reads a name with leading zeros as its number', () => {
    // http.address names another port, so the port can only come from the name.
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_00080', httpSection('change-me-a', ':9980'));
    hostdDirectory(root, 'sia_019980', httpSection('change-me-b', ':9980'));
    expect(discoverSiaNodes([root], '127.0.0.1').map((node) => node.host)).toEqual([
      '127.0.0.1:80',
      '127.0.0.1:19980',
    ]);
  });

  it('keeps a node whose hostd.yml has no password, without one', () => {
    const root = hostdDirectory(join(sandbox, 'root'), 'sia_9980', 'http:\n  address: :9980\n');
    expect(discoverSiaNodes([root], '127.0.0.1')).toEqual([
      { host: '127.0.0.1:9980', username: '', password: undefined },
    ]);
  });

  it('keeps a node whose hostd.yml has no http section, without a password', () => {
    const root = hostdDirectory(join(sandbox, 'root'), 'sia_9980', 'syncer:\n  password: x\n');
    expect(discoverSiaNodes([root], '127.0.0.1')).toEqual([
      { host: '127.0.0.1:9980', username: '', password: undefined },
    ]);
  });

  it('skips an entry without a readable hostd.yml', () => {
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_9980');
    hostdDirectory(root, 'sia_9981');
    mkdirSync(join(root, 'sia_9981', 'hostd.yml'));
    symlinkSync(join(sandbox, 'missing'), join(root, 'sia_9982'));
    hostdDirectory(root, 'sia_9983', httpSection('change-me'));

    expect(discoverSiaNodes([root], '127.0.0.1').map((node) => node.host)).toEqual([
      '127.0.0.1:9983',
    ]);
  });

  itUnlessRoot('skips a hostd.yml it may not read', () => {
    const root = join(sandbox, 'root');
    hostdDirectory(root, 'sia_9980', httpSection('change-me-a'));
    hostdDirectory(root, 'sia_9981', httpSection('change-me-b'));
    chmodSync(join(root, 'sia_9980', 'hostd.yml'), 0o000);

    expect(discoverSiaNodes([root], '127.0.0.1').map((node) => node.host)).toEqual([
      '127.0.0.1:9981',
    ]);
  });

  it('skips a root that does not exist or is not a directory, and scans the rest in order', () => {
    const first = hostdDirectory(join(sandbox, 'first'), 'sia_9990', httpSection('change-me-b'));
    const second = hostdDirectory(join(sandbox, 'second'), 'sia_9980', httpSection('change-me-a'));
    const file = join(sandbox, 'file');
    writeFileSync(file, 'not a directory');

    expect(
      discoverSiaNodes([join(sandbox, 'missing'), first, file, second], '127.0.0.1').map(
        (node) => node.host,
      ),
    ).toEqual(['127.0.0.1:9990', '127.0.0.1:9980']);
  });

  itUnlessRoot('skips a root it may not list', () => {
    const locked = hostdDirectory(join(sandbox, 'locked'), 'sia_9980', httpSection('change-me-a'));
    const open = hostdDirectory(join(sandbox, 'open'), 'sia_9981', httpSection('change-me-b'));
    chmodSync(locked, 0o000);
    try {
      expect(discoverSiaNodes([locked, open], '127.0.0.1').map((node) => node.host)).toEqual([
        '127.0.0.1:9981',
      ]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('puts the given host in front of the port', () => {
    const root = hostdDirectory(join(sandbox, 'root'), 'sia_9980', httpSection('change-me'));
    expect(discoverSiaNodes([root], '[fd00::5]')[0].host).toBe('[fd00::5]:9980');
    expect(discoverSiaNodes([root], 'sia.example')[0].host).toBe('sia.example:9980');
  });

  it('finds nothing without roots', () => {
    expect(discoverSiaNodes([], '127.0.0.1')).toEqual([]);
  });
});

describe('mergeDiscoveredNodes', () => {
  const discovered = (port: number, password: string): SiaNodeConfig => ({
    host: `127.0.0.1:${port}`,
    username: '',
    password,
  });

  it('replaces a configured node at the same address in place, keeping its walletHost', () => {
    const configured: SiaNodeConfig[] = [
      { host: '192.0.2.40:9980', username: 'sia-user', password: 'configured-a' },
      {
        host: 'http://127.0.0.1:9980/',
        username: 'sia-user',
        password: 'configured-b',
        walletHost: 'wallet.example:9990',
      },
      { host: '192.0.2.41:9980', password: 'configured-c', walletHost: 'wallet.example:9991' },
    ];

    expect(
      mergeDiscoveredNodes(configured, [
        discovered(9981, 'change-me-1'),
        discovered(9980, 'change-me-0'),
      ]),
    ).toEqual([
      configured[0],
      {
        host: '127.0.0.1:9980',
        username: '',
        password: 'change-me-0',
        walletHost: 'wallet.example:9990',
      },
      configured[2],
      { host: '127.0.0.1:9981', username: '', password: 'change-me-1' },
    ]);
  });

  it('replaces a node without a password by one without a password', () => {
    expect(
      mergeDiscoveredNodes(
        [{ host: '127.0.0.1:9980', password: 'configured' }],
        [{ host: '127.0.0.1:9980', username: '', password: undefined }],
      ),
    ).toEqual([
      { host: '127.0.0.1:9980', username: '', password: undefined, walletHost: undefined },
    ]);
  });

  it('compares scheme, host and port, not the text', () => {
    const configured: SiaNodeConfig[] = [
      { host: 'https://127.0.0.1:9980', password: 'configured-tls' },
      { host: '[FD00:0::5]:9980', password: 'configured-v6', walletHost: 'wallet.example:9990' },
    ];

    expect(
      mergeDiscoveredNodes(configured, [
        discovered(9980, 'change-me-0'),
        { host: '[fd00::5]:9980', username: '', password: 'change-me-v6' },
      ]),
    ).toEqual([
      configured[0],
      {
        host: '[fd00::5]:9980',
        username: '',
        password: 'change-me-v6',
        walletHost: 'wallet.example:9990',
      },
      discovered(9980, 'change-me-0'),
    ]);
  });

  it('keeps a node found twice once, at its first place, with the values found last', () => {
    expect(
      mergeDiscoveredNodes(
        [],
        [discovered(9980, 'first'), discovered(9981, 'other'), discovered(9980, 'last')],
      ),
    ).toEqual([discovered(9980, 'last'), discovered(9981, 'other')]);
  });

  it('keeps a node configured twice at a discovered address once, with the last walletHost', () => {
    const configured: SiaNodeConfig[] = [
      { host: '127.0.0.1:9980', password: 'configured-a', walletHost: 'wallet.example:9990' },
      { host: '192.0.2.40:9980', password: 'configured-b' },
      {
        host: 'http://127.0.0.1:9980/',
        password: 'configured-c',
        walletHost: 'wallet.example:9991',
      },
      { host: '127.0.0.1:9980', password: 'configured-d', walletHost: 'wallet.example:9992' },
    ];

    expect(mergeDiscoveredNodes(configured, [discovered(9980, 'change-me')])).toEqual([
      { ...discovered(9980, 'change-me'), walletHost: 'wallet.example:9992' },
      configured[1],
    ]);
  });

  it('takes the walletHost of the last copy even when that copy has none', () => {
    const configured: SiaNodeConfig[] = [
      { host: '127.0.0.1:9980', walletHost: 'wallet.example:9990' },
      { host: '127.0.0.1:9980' },
    ];

    expect(mergeDiscoveredNodes(configured, [discovered(9980, 'change-me')])).toEqual([
      { ...discovered(9980, 'change-me'), walletHost: undefined },
    ]);
  });

  it('keeps an address that does not parse, compared as written', () => {
    const unbracketed = { host: 'fd00::5:9980', username: '', password: 'change-me' };

    expect(mergeDiscoveredNodes([{ host: '127.0.0.1:9980' }], [unbracketed])).toEqual([
      { host: '127.0.0.1:9980' },
      unbracketed,
    ]);
    expect(
      mergeDiscoveredNodes(
        [{ host: 'fd00::5:9980', walletHost: 'wallet.example:9990' }],
        [unbracketed],
      ),
    ).toEqual([{ ...unbracketed, walletHost: 'wallet.example:9990' }]);
  });

  it('lists a node configured twice once, at its first place with the last values', () => {
    const configured: SiaNodeConfig[] = [
      { host: '192.0.2.40:9980', password: 'configured-a', walletHost: 'wallet-a.example:9980' },
      { host: '192.0.2.41:9980', password: 'other' },
      { host: 'http://192.0.2.40:9980/', password: 'configured-b' },
    ];
    const merged = [
      { host: 'http://192.0.2.40:9980/', password: 'configured-b' },
      { host: '192.0.2.41:9980', password: 'other' },
    ];
    expect(mergeDiscoveredNodes(configured, [])).toEqual(merged);
    expect(mergeDiscoveredNodes(configured, [discovered(9980, 'change-me')])).toEqual([
      ...merged,
      discovered(9980, 'change-me'),
    ]);
  });
});
