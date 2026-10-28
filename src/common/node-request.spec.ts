import {
  basicAuthorization,
  classifyNodeHealth,
  classifyTransportError,
  getNodeArray,
  getNodeObject,
  NodeRequestError,
  nodeRequestTimeoutMs,
  requestNodeText,
  toNodeFailure,
} from './node-request';
import { nodeBaseUrl } from './node-endpoint';
import {
  centsToDollars,
  hastingsToSiacoins,
  hastingsToSiacoinsOrUndefined,
  microDollarsToDollars,
  toNumberOrUndefined,
} from './node-numbers';

const originalFetch = global.fetch;

function codedError(code: string, message = `${code} message`): Error {
  return Object.assign(new Error(message), { code });
}

/** Rejects like undici: `TypeError('fetch failed')` with the socket error as its cause. */
function fetchFailing(cause: unknown): jest.Mock {
  return jest.fn(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause });
  });
}

async function failureOf(promise: Promise<unknown>): Promise<NodeRequestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NodeRequestError);
    return error as NodeRequestError;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe('transport failures are classified by error code, not by message text', () => {
  it.each([
    ['ECONNREFUSED', 'unreachable', 'offline'],
    ['ECONNRESET', 'unreachable', 'offline'],
    ['EHOSTUNREACH', 'unreachable', 'offline'],
    ['ENETUNREACH', 'unreachable', 'offline'],
    ['UND_ERR_SOCKET', 'unreachable', 'offline'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', 'offline'],
    ['ETIMEDOUT', 'timeout', 'offline'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout', 'offline'],
    ['ENOTFOUND', 'host_not_found', 'misconfigured'],
    ['EAI_AGAIN', 'host_not_found', 'misconfigured'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls', 'misconfigured'],
    ['CERT_HAS_EXPIRED', 'tls', 'misconfigured'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls', 'misconfigured'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls', 'misconfigured'],
  ])('%s -> %s (%s)', async (code, kind, health) => {
    global.fetch = fetchFailing(codedError(code, `connect ${code} 192.0.2.10:9980`));

    const failure = await failureOf(requestNodeText('http://192.0.2.10:9980/api/metrics'));

    expect(failure.kind).toBe(kind);
    expect(classifyNodeHealth(failure.kind)).toBe(health);
    // The socket message, not undici's generic "fetch failed"; never the request URL.
    expect(failure.message).toBe(`connect ${code} 192.0.2.10:9980`);
    expect(failure.message).not.toContain('/api/');
  });

  it('an unrecognised transport failure is unreachable', () => {
    expect(classifyTransportError(new TypeError('fetch failed'))).toBe('unreachable');
  });

  it('without an error code the deepest cause names the failure', async () => {
    global.fetch = fetchFailing(new Error('socket hang up'));

    const failure = await failureOf(requestNodeText('http://192.0.2.10:9980/api/metrics'));

    expect(failure.kind).toBe('unreachable');
    expect(failure.message).toBe('socket hang up');
  });

  it('a port that fetch refuses to use is an invalid endpoint, not an offline node', async () => {
    global.fetch = fetchFailing(new Error('bad port'));

    const failure = await failureOf(requestNodeText('http://192.0.2.10:6000/api/sno/'));

    expect(failure.kind).toBe('invalid_endpoint');
    expect(classifyNodeHealth(failure.kind)).toBe('misconfigured');
  });

  it('a timeout anywhere in the cause chain wins', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    expect(classifyTransportError(Object.assign(new Error('outer'), { cause: timeout }))).toBe(
      'timeout',
    );
  });
});

describe('requestNodeText', () => {
  it('aborts a request that does not answer within the timeout', async () => {
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;

    const started = Date.now();
    const failure = await failureOf(
      requestNodeText('http://192.0.2.10:9980/api/metrics', { timeoutMs: 50 }),
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failure.kind).toBe('timeout');
    expect(classifyNodeHealth(failure.kind)).toBe('offline');
    expect(failure.message).toBe('Request timed out after 0.05 s');
  });

  it.each([
    [401, 'Unauthorized', 'unauthorized'],
    [403, 'Forbidden', 'unauthorized'],
    [404, 'Not Found', 'http_status'],
    [502, 'Bad Gateway', 'http_status'],
  ])('HTTP %i is %s', async (status, statusText, kind) => {
    global.fetch = jest.fn(async () => new Response('{"error":"nope"}', { status, statusText }));

    const failure = await failureOf(requestNodeText('http://192.0.2.10:9980/api/wallet'));

    expect(failure.kind).toBe(kind);
    expect(classifyNodeHealth(failure.kind)).toBe('misconfigured');
    expect(failure.message).toBe(
      `Request failed with status ${status} ${statusText} {"error":"nope"}`,
    );
  });

  it('a URL that cannot be built is an invalid endpoint, without a request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const failure = await failureOf(requestNodeText('http://fe80::1/api/metrics'));

    expect(failure.kind).toBe('invalid_endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a URL with user credentials is an invalid endpoint, without a request or the password', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const failure = await failureOf(requestNodeText('http://user:secretpw@127.0.0.1:9/api/sno/'));

    expect(failure.kind).toBe('invalid_endpoint');
    expect(failure.message).not.toContain('secretpw');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Accept and the Authorization header and reads the body', async () => {
    const fetchMock = jest.fn(async () => new Response('[]'));
    global.fetch = fetchMock;

    await requestNodeText('https://node.example:9980/api/metrics', { authorization: 'Basic x' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://node.example:9980/api/metrics');
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: 'Basic x' });
    expect(init.method).toBe('GET');
    expect(init.signal).toBeDefined();
  });
});

describe('payload shape', () => {
  it('HTML from a UI route is an invalid response', async () => {
    global.fetch = jest.fn(async () => new Response('<!doctype html><html></html>'));

    const failure = await failureOf(getNodeObject('http://192.0.2.10:9980/wallet'));

    expect(failure.kind).toBe('invalid_response');
    expect(classifyNodeHealth(failure.kind)).toBe('misconfigured');
  });

  it('a JSON null where an array is expected is empty only when asked', async () => {
    // Go's encoding/json writes an empty (nil) slice as null.
    global.fetch = jest.fn(async () => new Response('null\n'));

    expect((await failureOf(getNodeArray('http://192.0.2.10:14002/api/x'))).kind).toBe(
      'invalid_response',
    );
    expect(await getNodeArray('http://192.0.2.10:14002/api/x', { nullAsEmpty: true })).toEqual([]);
  });

  it('an object where an array is expected is an invalid response', async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"x"}'));

    expect((await failureOf(getNodeArray('http://192.0.2.10:9980/api/metrics/daily'))).kind).toBe(
      'invalid_response',
    );
  });
});

describe('toNodeFailure', () => {
  it('keeps the kind of a request failure and calls anything else unknown', () => {
    expect(toNodeFailure(new NodeRequestError('unauthorized', 'HTTP 401'))).toEqual({
      errorKind: 'unauthorized',
      health: 'misconfigured',
      message: 'HTTP 401',
    });
    expect(toNodeFailure(new TypeError('x is undefined'))).toEqual({
      errorKind: 'unknown',
      health: 'misconfigured',
      message: 'x is undefined',
    });
  });

  it('never passes a URL on to the API, credentials included', () => {
    const failure = toNodeFailure(
      new TypeError(
        'Request cannot be constructed from a URL that includes credentials: http://user:secretpw@127.0.0.1:9/api/sno/',
      ),
    );

    expect(failure.message).toBe(
      'Request cannot be constructed from a URL that includes credentials: <url>',
    );
  });
});

describe('toNodeFailure and the address help text', () => {
  it('passes the help text on whole, https example included', () => {
    let thrown: unknown;
    try {
      nodeBaseUrl('localhost');
    } catch (error) {
      thrown = error;
    }

    expect(toNodeFailure(thrown).message).toBe(
      'Invalid node address: use host:port, https://host:port or [IPv6]:port',
    );
  });

  it('still masks a URL quoted by an engine error that became a request failure', () => {
    const failure = toNodeFailure(
      new NodeRequestError('unreachable', 'connect failed for http://user:secretpw@192.0.2.1:9/'),
    );

    expect(failure.message).toBe('connect failed for <url>');
  });
});

describe('nodeRequestTimeoutMs', () => {
  it('defaults to 30 s and accepts a positive override', () => {
    expect(nodeRequestTimeoutMs({})).toBe(30_000);
    expect(nodeRequestTimeoutMs({ NODE_REQUEST_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(nodeRequestTimeoutMs({ NODE_REQUEST_TIMEOUT_MS: 'soon' })).toBe(30_000);
    expect(nodeRequestTimeoutMs({ NODE_REQUEST_TIMEOUT_MS: '0' })).toBe(30_000);
  });
});

describe('basicAuthorization', () => {
  // Guard, not a fix: Buffer already encodes UTF-8 (the Android app's OkHttp default was Latin-1).
  it('encodes credentials as UTF-8', () => {
    expect(basicAuthorization('', 'пароль2024')).toBe(
      `Basic ${Buffer.from(':пароль2024', 'utf8').toString('base64')}`,
    );
    expect(basicAuthorization('', 'café')).toBe('Basic OmNhZsOp');
  });

  it('sends nothing without credentials', () => {
    expect(basicAuthorization('', '')).toBeUndefined();
    expect(basicAuthorization(undefined, undefined)).toBeUndefined();
  });
});

describe('number parsing', () => {
  it('reads numbers and numeric strings only', () => {
    expect(toNumberOrUndefined(42)).toBe(42);
    expect(toNumberOrUndefined(' 1.5e3 ')).toBe(1500);
    expect(toNumberOrUndefined('1000000000000000000000000000')).toBe(1e27);
    expect(toNumberOrUndefined(true)).toBeUndefined();
    expect(toNumberOrUndefined('')).toBeUndefined();
    expect(toNumberOrUndefined('abc')).toBeUndefined();
    expect(toNumberOrUndefined(null)).toBeUndefined();
    expect(toNumberOrUndefined({})).toBeUndefined();
    expect(toNumberOrUndefined(Number.NaN)).toBeUndefined();
  });

  it('converts cents, micro-dollars and hastings without NaN', () => {
    expect(centsToDollars(840)).toBeCloseTo(8.4);
    expect(centsToDollars('840')).toBeCloseTo(8.4);
    expect(centsToDollars({})).toBe(0);
    expect(centsToDollars(true)).toBe(0);
    expect(microDollarsToDollars(3_000_000)).toBe(3);
    expect(hastingsToSiacoins('25000000000000000000000000')).toBeCloseTo(25);
    expect(hastingsToSiacoinsOrUndefined(undefined)).toBeUndefined();
    expect(hastingsToSiacoins(undefined)).toBe(0);
  });
});
