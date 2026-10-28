import { NodeRequestError } from './node-request';

/** Scheme of a node address. A bare `host:port` means http. */
export type NodeScheme = 'http' | 'https';

/**
 * A node address as written in the config: `[http://|https://]host[:port][/]`.
 * The host is a name, an IPv4 address or a bracketed IPv6 address (`[fe80::1]:9980`).
 * The port (1..65535) is required for a bare `host:port`; with a scheme it defaults to the
 * scheme's port (`https://host` is port 443, `http://host` port 80). Same rules as the
 * StorageMan app's `NodeEndpoint`, plus one that fetch needs here: the host must read the same to
 * the WHATWG URL parser (see [readsAsSameHost]). The app holds new addresses to the numeric part
 * of that rule (`NodeEndpoint.readsAsAnotherHost`), not to the `xn--` check, and keeps reading
 * nodes it saved before.
 */
export interface NodeEndpoint {
  scheme: NodeScheme;
  /** Host without brackets, e.g. `fe80::1` for `[fe80::1]:9980`. */
  host: string;
  port: number;
  /** `scheme://host:port`, no trailing slash; request paths are appended to it. */
  baseUrl: string;
}

const HOST_LABEL = '[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?';

/** Dot-separated labels of letters, digits, '_' and inner '-' (IPv4 addresses included). */
const HOST_NAME = new RegExp(`^${HOST_LABEL}(\\.${HOST_LABEL})*$`);

const SCHEMES: NodeScheme[] = ['http', 'https'];

/** Port of an address that has a scheme but no port. */
const DEFAULT_PORTS: Record<NodeScheme, number> = { http: 80, https: 443 };

/** Returns undefined for anything that is not a valid endpoint. */
export function parseNodeEndpoint(raw: string): NodeEndpoint | undefined {
  let rest = raw.trim();
  if (!rest) {
    return undefined;
  }

  let scheme: NodeScheme | undefined;
  const schemeSeparator = rest.indexOf('://');
  if (schemeSeparator >= 0) {
    const name = rest.slice(0, schemeSeparator).toLowerCase();
    scheme = SCHEMES.find((candidate) => candidate === name);
    if (!scheme) {
      return undefined;
    }
    rest = rest.slice(schemeSeparator + 3);
  }
  if (rest.endsWith('/')) {
    rest = rest.slice(0, -1);
  }

  // Undefined when the address ends after the host.
  let portText: string | undefined;
  let host: string;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) {
      return undefined;
    }
    host = rest.slice(1, close);
    if (!isIpv6Literal(host)) {
      return undefined;
    }
    const afterHost = rest.slice(close + 1);
    if (afterHost) {
      if (!afterHost.startsWith(':')) {
        return undefined;
      }
      portText = afterHost.slice(1);
    }
  } else {
    const separator = rest.lastIndexOf(':');
    host = separator < 0 ? rest : rest.slice(0, separator);
    if (!HOST_NAME.test(host)) {
      return undefined;
    }
    if (separator >= 0) {
      portText = rest.slice(separator + 1);
    }
  }

  let port: number;
  if (portText === undefined) {
    // Only a scheme says which port is meant; a bare host stays invalid, as before.
    if (!scheme) {
      return undefined;
    }
    port = DEFAULT_PORTS[scheme];
  } else {
    if (!/^[0-9]{1,5}$/.test(portText)) {
      return undefined;
    }
    port = Number(portText);
    if (port < 1 || port > 65535) {
      return undefined;
    }
  }
  // A bare host:port is http.
  scheme ??= 'http';

  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  const baseUrl = `${scheme}://${hostForUrl}:${port}`;
  if (!readsAsSameHost(baseUrl, host)) {
    return undefined;
  }
  return { scheme, host, port, baseUrl };
}

/**
 * fetch and the browser read a URL with the WHATWG parser, which rejects some names the grammar
 * above allows (an IPv4 octet over 255 such as `256.1.1.1`, a numeric last label such as
 * `host.123` or `1.2.3.4.5`, a malformed `xn--` label) and reads other numeric names as a
 * different IPv4 address (`010.0.0.1` is 8.0.0.1, `0x7f.1` is 127.0.0.1, `1.2.3` is 1.2.0.3).
 * The rule is any difference between the parsed hostname and the text, ignoring case, so a name
 * written back as the same address in another form (`192.168.1.05` as 192.168.1.5) is refused too.
 * The address is then invalid, so a node is never requested or linked on a host other than the
 * one configured. An IPv6 literal comes back in canonical form, so its text is not compared: the
 * parser reads every one the grammar accepts as the same address, except one whose dotted IPv4
 * tail has a leading zero (`::ffff:192.168.1.05`), which it rejects, so that one is refused.
 */
function readsAsSameHost(baseUrl: string, host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host.includes(':') || hostname === host.toLowerCase();
}

/**
 * Base URL (`scheme://host:port`) for a configured host, Storj and Sia alike (`host` and
 * `walletHost`). A bare `host:port` stays http; `https://host` and `http://host` get the scheme's
 * default port. Anything that does not parse (a bare host without a port, a path, user
 * credentials, an unknown scheme, a host such as `256.1.1.1` or `192.168.1.05` that the WHATWG
 * URL parser does not give back as written, see [readsAsSameHost]) is rejected as an invalid
 * endpoint, so the node shows as misconfigured instead of being requested on a guessed URL. The
 * message never echoes the value, which may hold a password.
 */
export function nodeBaseUrl(raw: string): string {
  const endpoint = parseNodeEndpoint(raw);
  if (!endpoint) {
    throw new NodeRequestError(
      'invalid_endpoint',
      'Invalid node address: use host:port, https://host:port or [IPv6]:port',
      { fixedText: true },
    );
  }
  return endpoint.baseUrl;
}

/**
 * The configured address as the API and the UI show it. A valid address never has user
 * credentials; in any other value everything up to the last `@` is masked, so a password typed
 * into the address does not reach the dashboard.
 */
export function displayNodeHost(raw: string): string {
  return raw.replace(/^(\s*(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?).*@/, '$1***@');
}

/**
 * RFC 4291 text form without a zone: up to eight 1-4 digit hex groups, at most one `::`,
 * optionally ending in a dotted IPv4 address (`::ffff:192.0.2.1`).
 */
function isIpv6Literal(text: string): boolean {
  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) {
    return false;
  }
  let address = text;
  if (text.includes('.')) {
    if (!isIpv4Literal(text.slice(lastColon + 1))) {
      return false;
    }
    // The IPv4 tail stands for two groups.
    address = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return false;
  }
  const groups = halves.filter((half) => half.length > 0).flatMap((half) => half.split(':'));
  if (groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) {
    return false;
  }
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

function isIpv4Literal(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 && parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)
  );
}
