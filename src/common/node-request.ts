import { Buffer } from 'buffer';

/**
 * Why a request to a node failed, decided from error codes and HTTP statuses, never from message
 * text. Same kinds as the StorageMan app.
 */
export type NodeErrorKind =
  /** No answer in time (connect, headers, body or the overall request timeout). */
  | 'timeout'
  /** Connection refused or reset, network down, or any other transport failure. */
  | 'unreachable'
  /** The host name did not resolve. */
  | 'host_not_found'
  /** TLS handshake or certificate failure (https nodes). */
  | 'tls'
  /** HTTP 401/403: wrong or missing password. */
  | 'unauthorized'
  /** Any other non-2xx HTTP status (wrong port, wrong service, server error). */
  | 'http_status'
  /** 2xx response that is not the expected JSON (wrong service on that port). */
  | 'invalid_response'
  /** The configured address cannot form a URL. */
  | 'invalid_endpoint'
  /** Anything else, e.g. a bug in payload handling. */
  | 'unknown';

/** Health of a node whose fetch failed. */
export type NodeFailureHealth = 'offline' | 'misconfigured';

/** Overall cap per node request, as in the StorageMan app (its connect/read limits are 5 s/10 s). */
export const NODE_REQUEST_TIMEOUT_MS = 30_000;

/** `NODE_REQUEST_TIMEOUT_MS` from the environment when it is a positive number, else 30 s. */
export function nodeRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.NODE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : NODE_REQUEST_TIMEOUT_MS;
}

const ERROR_BODY_PREVIEW_LENGTH = 180;

/** A request to a node (or its payload) failed. The message never contains the request URL. */
export class NodeRequestError extends Error {
  readonly cause?: unknown;
  /**
   * The message is fixed text of this code, such as a help text quoting `https://host:port`, so
   * [toNodeFailure] passes it on unchanged instead of masking what looks like a URL.
   */
  readonly fixedText: boolean;

  constructor(
    readonly kind: NodeErrorKind,
    message: string,
    options?: { cause?: unknown; fixedText?: boolean },
  ) {
    super(message);
    this.name = 'NodeRequestError';
    this.cause = options?.cause;
    this.fixedText = options?.fixedText ?? false;
  }
}

/** A payload that came back 2xx but is not what the node API returns. */
export function invalidResponse(message: string): never {
  throw new NodeRequestError('invalid_response', message);
}

/**
 * Only "no answer" failures (timeout, refused or reset connection, network down) are offline. A
 * host name that does not resolve and a TLS failure are misconfigured, like a refused password,
 * an unexpected HTTP status, a payload that is not the node API and an unknown failure.
 */
export function classifyNodeHealth(kind: NodeErrorKind): NodeFailureHealth {
  return kind === 'timeout' || kind === 'unreachable' ? 'offline' : 'misconfigured';
}

/** A `scheme://...` run inside a message, such as a URL quoted by an engine error. */
const URL_IN_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;

/**
 * What a failed node reports: a [NodeRequestError] keeps its kind, anything else is unknown. This
 * message goes into the API response and the UI, so any URL in a message this code did not write
 * (an engine error or a response body; a URL may carry credentials) is replaced by `<url>`.
 */
export function toNodeFailure(error: unknown): {
  errorKind: NodeErrorKind;
  health: NodeFailureHealth;
  message: string;
} {
  const errorKind = error instanceof NodeRequestError ? error.kind : 'unknown';
  const raw = error instanceof Error && error.message.trim() ? error.message : 'Unknown error';
  const message =
    error instanceof NodeRequestError && error.fixedText ? raw : raw.replace(URL_IN_TEXT, '<url>');
  return { errorKind, health: classifyNodeHealth(errorKind), message };
}

/** `Basic base64(username:password)` from UTF-8 bytes, or undefined without credentials. */
export function basicAuthorization(username?: string, password?: string): string | undefined {
  const user = username ?? '';
  const pass = password ?? '';
  if (user === '' && pass === '') {
    return undefined;
  }
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

export interface NodeRequestOptions {
  method?: 'GET' | 'POST';
  authorization?: string;
  timeoutMs?: number;
}

/**
 * Every node request goes through here. A failure is thrown as a [NodeRequestError]:
 * - no HTTP response: a timeout is `timeout`; DNS, TLS and connection errors are named by their
 *   error code (see [classifyTransportError]); anything else is `unreachable`;
 * - 401/403 is `unauthorized`; any other non-2xx is `http_status`;
 * - a URL that cannot be parsed or carries user credentials is `invalid_endpoint`.
 * The whole request (connect, headers and body) is capped by [nodeRequestTimeoutMs].
 */
export async function requestNodeText(
  url: string,
  options: NodeRequestOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? nodeRequestTimeoutMs();
  // Checked before the transport guard: a malformed address is a configuration problem, not a
  // network failure. The message leaves the URL out.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new NodeRequestError('invalid_endpoint', 'Invalid node address', { cause: error });
  }
  // fetch refuses such a URL and quotes it, password included, in its error.
  if (parsed.username || parsed.password) {
    throw new NodeRequestError(
      'invalid_endpoint',
      'Node address must not contain user credentials',
    );
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  let status: number;
  let statusText: string;
  let body: string;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    statusText = response.statusText;
    body = await response.text();
  } catch (error) {
    throw transportFailure(error, timeoutMs);
  }

  if (status < 200 || status > 299) {
    const kind: NodeErrorKind = status === 401 || status === 403 ? 'unauthorized' : 'http_status';
    const preview = body.slice(0, ERROR_BODY_PREVIEW_LENGTH);
    throw new NodeRequestError(
      kind,
      `Request failed with status ${status} ${statusText} ${preview}`.replace(/\s+/g, ' ').trim(),
    );
  }

  return body;
}

export async function getNodeObject(
  url: string,
  options: NodeRequestOptions = {},
): Promise<Record<string, any>> {
  const parsed = parseJson(await requestNodeText(url, options));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalidResponse('Response is not valid JSON');
  }
  return parsed as Record<string, any>;
}

export interface NodeArrayOptions extends NodeRequestOptions {
  /**
   * Reads a JSON `null` body as an empty array: Go's encoding/json writes an empty (nil) slice as
   * `null`, as storagenode does for a paystub range without paystubs.
   */
  nullAsEmpty?: boolean;
}

export async function getNodeArray(url: string, options: NodeArrayOptions = {}): Promise<any[]> {
  const parsed = parseJson(await requestNodeText(url, options));
  if (options.nullAsEmpty && parsed === null) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    invalidResponse('Response is not a JSON array');
  }
  return parsed;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const HOST_NOT_FOUND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);
const TLS_CODES = new Set([
  'EPROTO',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const TLS_CODE_PREFIXES = ['ERR_TLS_', 'ERR_SSL_', 'ERR_OSSL_', 'CERT_'];

/** The kind told by one link of a failure's cause chain, or undefined when it says nothing. */
function kindOfLink(link: unknown): NodeErrorKind | undefined {
  if (!link || typeof link !== 'object') {
    return undefined;
  }
  const { name, code } = link as { name?: unknown; code?: unknown };
  if (name === 'TimeoutError') {
    return 'timeout';
  }
  if (typeof code !== 'string') {
    return undefined;
  }
  if (TIMEOUT_CODES.has(code)) {
    return 'timeout';
  }
  if (HOST_NOT_FOUND_CODES.has(code)) {
    return 'host_not_found';
  }
  if (TLS_CODES.has(code) || TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return 'tls';
  }
  if (UNREACHABLE_CODES.has(code)) {
    return 'unreachable';
  }
  return undefined;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current && chain.length < 16 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Kind of a request that produced no HTTP response: the first link of the cause chain with a
 * known name or code decides; an unrecognised failure is `unreachable`.
 */
export function classifyTransportError(error: unknown): NodeErrorKind {
  for (const link of causeChain(error)) {
    const kind = kindOfLink(link);
    if (kind) {
      return kind;
    }
  }
  return 'unreachable';
}

/**
 * Short detail for the UI, never the URL: the engine message of the link that carries an error
 * code (`connect ECONNREFUSED 10.0.0.5:9980` rather than undici's `fetch failed`), else the
 * deepest cause's message.
 */
function transportFailure(error: unknown, timeoutMs: number): NodeRequestError {
  if (error instanceof NodeRequestError) {
    return error;
  }
  const chain = causeChain(error);
  // fetch refuses ports on the Fetch spec's blocklist (e.g. 6000, 6666, 10080) before connecting
  // and gives no error code, only this cause; it is a config problem, not a node that is down.
  if (chain.some((link) => link instanceof Error && link.message === 'bad port')) {
    return new NodeRequestError('invalid_endpoint', 'Port not allowed by fetch (bad port)', {
      cause: error,
    });
  }
  const kind = classifyTransportError(error);
  if (kind === 'timeout' && chain.some((link) => isTimeoutName(link))) {
    return new NodeRequestError(kind, `Request timed out after ${timeoutMs / 1000} s`, {
      cause: error,
    });
  }
  const messages = chain.map((link) => (link instanceof Error ? link.message.trim() : ''));
  const codedIndex = chain.findIndex(
    (link, index) =>
      link instanceof Error &&
      typeof (link as { code?: unknown }).code === 'string' &&
      messages[index],
  );
  const detail =
    (codedIndex >= 0 ? messages[codedIndex] : [...messages].reverse().find(Boolean)) ||
    'Request failed';
  return new NodeRequestError(kind, detail, { cause: error });
}

function isTimeoutName(link: unknown): boolean {
  return Boolean(
    link && typeof link === 'object' && (link as { name?: unknown }).name === 'TimeoutError',
  );
}
