import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { nodeEndpointKey } from '../common/node-endpoint';

/** A Sia node to request: from SIA_NODES_JSON, the legacy flat variables or discovery. */
export interface SiaNodeConfig {
  host: string;
  username?: string;
  password?: string;
  walletHost?: string;
}

/** Host of the discovered nodes when SIA_DISCOVERY_HOST is not set. */
export const DEFAULT_DISCOVERY_HOST = '127.0.0.1';

/** A hostd directory under a discovery root: `sia_` and the port hostd is published on. */
const NODE_DIRECTORY = /^sia_(\d+)$/;

/** What discovery reads from the top-level `http:` section of a hostd.yml. */
export interface HostdHttpConfig {
  address?: string;
  password?: string;
}

/** The directories of SIA_DISCOVERY_ROOTS: comma-separated, trimmed, empty ones and repeats left out. */
export function parseDiscoveryRoots(raw: string | undefined): string[] {
  const roots = (raw ?? '')
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean);
  return [...new Set(roots)];
}

/**
 * The hostd nodes under `roots`, root by root in the order given: every entry named
 * `sia_<digits>` that is a directory or a symbolic link (followed), in numeric order of the digits.
 * A node is `<host>:<port>` with an empty username and the password of its `hostd.yml`. The port is
 * the number in the name (the port hostd is published on) or, when that is not a port (0 or over
 * 65535), the port at the end of the hostd.yml `http.address`. A root or a hostd.yml that cannot be
 * read and an entry without a port are left out, and nothing is logged: the values are a password
 * and an address. Reads the disk on every call, so a node added under a root shows without a
 * restart; resolve the nodes once per request.
 */
export function discoverSiaNodes(roots: readonly string[], host: string): SiaNodeConfig[] {
  const nodes: SiaNodeConfig[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) && NODE_DIRECTORY.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort(compareNodeDirectories);
    } catch {
      continue;
    }

    for (const name of names) {
      let contents: string;
      try {
        contents = readFileSync(join(root, name, 'hostd.yml'), 'utf8');
      } catch {
        continue;
      }
      const { address, password } = readHostdHttpConfig(contents);
      const port =
        toPort(NODE_DIRECTORY.exec(name)?.[1]) ?? toPort(/(?:^|:)(\d+)$/.exec(address ?? '')?.[1]);
      if (port === undefined) {
        continue;
      }
      nodes.push({ host: `${host}:${port}`, username: '', password });
    }
  }
  return nodes;
}

/**
 * `address` and `password` of the top-level `http:` section of a hostd.yml, the first of each
 * there. Only the section's own keys count: the same keys in another section or nested deeper are
 * ignored. Blank lines and comments are skipped, and a value is read as YAML reads a scalar on one
 * line: quotes removed (with `\` escapes in double quotes and `''` in single quotes), a trailing
 * `# comment` dropped.
 */
export function readHostdHttpConfig(contents: string): HostdHttpConfig {
  const config: HostdHttpConfig = {};
  let inHttpSection = false;
  /** Indentation of the section's keys, set by its first line. */
  let keyIndentation: number | undefined;

  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) {
      inHttpSection = /^http:(\s+#.*)?$/.test(trimmed);
      keyIndentation = undefined;
      continue;
    }
    if (!inHttpSection) {
      continue;
    }
    keyIndentation ??= indentation;
    if (indentation !== keyIndentation) {
      continue;
    }

    config.address ??= readYamlValue(trimmed, 'address');
    config.password ??= readYamlValue(trimmed, 'password');
  }
  return config;
}

/**
 * The configured nodes with the discovered ones merged in, each discovered node once. A discovered
 * node takes the place of the configured node at the same address, compared as scheme, host and
 * port (see nodeEndpointKey: so `127.0.0.1:9980` and `http://127.0.0.1:9980` are one node,
 * `https://127.0.0.1:9980` another), with its own address, empty username and password, and the
 * configured node's walletHost; the other discovered nodes follow the configured ones in the order
 * found. Like the keys of a map, a node listed twice is kept once, at its first place, with the
 * values listed last: found twice (under two roots, or as `sia_9980` and `sia_09980`), it has the
 * password found last; configured twice (in the same or another spelling), it has the address,
 * username, password and walletHost of the last copy, or at a discovered address the discovered
 * values with the walletHost of the last copy, and the other copies are left out, so the node is
 * not requested and counted twice. This holds with no node discovered too, as on the servers that
 * ran the first version of discovery. An address that does not parse (an IPv6 SIA_DISCOVERY_HOST
 * without brackets) is compared as written and kept, so that node shows as misconfigured
 * (`invalid_endpoint`), as a configured address that does not parse does.
 */
export function mergeDiscoveredNodes(
  configured: readonly SiaNodeConfig[],
  discovered: readonly SiaNodeConfig[],
): SiaNodeConfig[] {
  const keyOf = (host: string) => nodeEndpointKey(host) ?? `unparsed:${host.trim()}`;
  const discoveredByKey = new Map<string, SiaNodeConfig>();
  for (const node of discovered) {
    discoveredByKey.set(keyOf(node.host), node);
  }
  // A Map keeps each key at its first place and the value set last.
  const configuredByKey = new Map<string, SiaNodeConfig>();
  for (const node of configured) {
    configuredByKey.set(keyOf(node.host), node);
  }

  const nodes: SiaNodeConfig[] = [];
  for (const [key, node] of configuredByKey) {
    const found = discoveredByKey.get(key);
    if (found) {
      nodes.push({ ...found, walletHost: node.walletHost });
      discoveredByKey.delete(key);
    } else {
      nodes.push(node);
    }
  }
  nodes.push(...discoveredByKey.values());
  return nodes;
}

/** `sia_<digits>` names by the number, without converting it, then by the name. */
function compareNodeDirectories(left: string, right: string): number {
  const digits = (name: string) => name.slice('sia_'.length).replace(/^0+(?=\d)/, '');
  const [leftDigits, rightDigits] = [digits(left), digits(right)];
  return (
    leftDigits.length - rightDigits.length ||
    compareText(leftDigits, rightDigits) ||
    compareText(left, right)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPort(digits: string | undefined): number | undefined {
  const port = digits === undefined ? Number.NaN : Number(digits);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** The value of `<key>: <value>` on a trimmed line, or undefined for another key. */
function readYamlValue(line: string, key: string): string | undefined {
  if (!line.startsWith(`${key}:`)) {
    return undefined;
  }
  const value = line.slice(key.length + 1).trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const quoted = readQuotedScalar(value, quote);
    if (quoted !== undefined) {
      return quoted;
    }
  }
  // A plain scalar ends where a comment begins: a `#` at the start or after a space.
  return value.replace(/(^|\s+)#.*$/, '');
}

/** Escapes of a YAML double-quoted scalar (those yaml.v3, which hostd uses, writes and more). */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
};

const HEX_ESCAPE_DIGITS: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * A quoted scalar that ends on its line, without its quotes and with its escapes applied; what
 * follows the closing quote (a comment) is ignored. Undefined when the quote is not closed.
 */
function readQuotedScalar(value: string, quote: '"' | "'"): string | undefined {
  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        result += "'";
        index += 1;
        continue;
      }
      return result;
    }
    if (quote === '"' && char === '\\' && index + 1 < value.length) {
      const code = value[index + 1];
      const hexDigits = HEX_ESCAPE_DIGITS[code];
      const hex = hexDigits ? value.slice(index + 2, index + 2 + hexDigits) : '';
      const codePoint =
        hex.length === hexDigits && /^[0-9A-Fa-f]+$/.test(hex) ? parseInt(hex, 16) : -1;
      if (codePoint >= 0 && codePoint <= 0x10ffff) {
        result += String.fromCodePoint(codePoint);
        index += 1 + hexDigits;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(DOUBLE_QUOTED_ESCAPES, code)) {
        result += DOUBLE_QUOTED_ESCAPES[code];
        index += 1;
        continue;
      }
    }
    result += char;
  }
  return undefined;
}
