import { StorjService } from './storj.service';
import { StorjNodeStatus, StorjNodeSuccess, StorjSummary } from './storj.types';

// The real runtime-env reads ./.env (real node hosts); tests use their own config.
const mockEnv: Record<string, string | undefined> = {};
jest.mock('../runtime-env', () => ({
  getRuntimeEnv: (name: string) => mockEnv[name],
}));

const NOW = new Date('2026-10-25T12:00:00Z');
const originalFetch = global.fetch;

// Month so far: gross 10.50 USD (400 + 200 + 450 c), net 8.40, held 2.10.
// Previous month: gross 15.00, net 12.00, held 3.00.
const ESTIMATED_PAYOUT = {
  currentMonth: {
    egressBandwidth: 2_000_000_000_000,
    egressBandwidthPayout: 400,
    egressRepairAudit: 1_000_000_000_000,
    egressRepairAuditPayout: 200,
    diskSpace: 3_000_000_000_000,
    diskSpacePayout: 450,
    heldRate: 20,
    payout: 840,
    held: 210,
  },
  previousMonth: {
    egressBandwidthPayout: 1000,
    egressRepairAuditPayout: 0,
    diskSpacePayout: 500,
    heldRate: 20,
    payout: 1200,
    held: 300,
  },
  currentMonthExpectations: 2000,
};

const NODE_STATS = {
  nodeID: '1abc',
  diskSpace: { used: 4e12, available: 6e12, trash: 1e9, overused: 0 },
  quicStatus: 'OK',
};

/** A storagenode paystub (micro-USD): owed = earned - held + disposed. */
function paystub(
  period: string,
  held: number,
  owed: number,
  disposed: number,
  paid: number,
  distributed: number,
) {
  return { satelliteId: 'sat', period, held, owed, disposed, paid, distributed };
}

// Earned 6.00 + 4.50 + 1.25 = 11.75; paid 4.25, held 3.50, disposed (held returned) 2.00,
// distributed 10.45. One September paystub has its payment held back (paid 0, owed 6.00), as the
// real 2026-07 paystubs. September is covered.
const PAYSTUBS = [
  paystub('2026-08', 3_000_000, 3_000_000, 0, 3_000_000, 3_000_000),
  paystub('2026-09', 500_000, 6_000_000, 2_000_000, 0, 6_200_000),
  paystub('2026-09', 0, 1_250_000, 0, 1_250_000, 1_250_000),
];

function bandwidthDay(date: string, usage: number, repair: number, audit: number) {
  return {
    egress: { repair, audit, usage },
    ingress: { repair: 7_000_000_000, usage: 90_000_000_000 },
    delete: 0,
    intervalStart: `${date}T00:00:00Z`,
  };
}

const SATELLITES = {
  storageDaily: [],
  bandwidthDaily: [
    bandwidthDay('2026-10-23', 800_000_000_000, 2_000_000_000, 1_000_000_000),
    bandwidthDay('2026-10-24', 900_000_000_000, 1, 1),
    bandwidthDay('2026-10-25', 100_000_000_000, 50_000_000_000, 1_000_000_000),
  ],
  bandwidthSummary: 1_500_000_000_000,
  egressSummary: 1_000_000_000_000,
  ingressSummary: 500_000_000_000,
  audits: [{ auditScore: 1, suspensionScore: 1, onlineScore: 0.99, satelliteName: 'us1' }],
};

type Route = (path: string) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What storagenode answers for a paystub range without paystubs: a nil Go slice is `null`. */
function noPaystubs(): Response {
  return new Response('null\n', { status: 200, headers: { 'content-type': 'application/json' } });
}

function nodeRoute(overrides: Record<string, () => Response> = {}): Route {
  return (path) => {
    const override = Object.entries(overrides).find(([prefix]) => path.startsWith(prefix));
    if (override) {
      return override[1]();
    }
    if (path === '/api/sno/estimated-payout') return json(ESTIMATED_PAYOUT);
    if (path.startsWith('/api/heldamount/paystubs/')) return json(PAYSTUBS);
    if (path === '/api/sno/') return json(NODE_STATS);
    if (path === '/api/sno/satellites') return json(SATELLITES);
    return json({ error: 'not found' }, 404);
  };
}

/** Routes by URL origin; records every requested URL. */
function mockFetch(routes: Record<string, Route>): string[] {
  const requested: string[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const parsed = new URL(url);
    const route = routes[parsed.origin];
    if (!route) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${parsed.host}`), {
          code: 'ECONNREFUSED',
        }),
      });
    }
    return route(parsed.pathname);
  }) as unknown as typeof fetch;
  return requested;
}

function configure(...hosts: string[]): void {
  mockEnv.STORJ_NODES_JSON = JSON.stringify(hosts.map((host) => ({ host })));
}

async function fetchSummary(): Promise<StorjSummary> {
  return new StorjService().fetchSummary();
}

function ok(node: StorjNodeStatus): StorjNodeSuccess {
  expect(node.status).toBe('ok');
  return node as StorjNodeSuccess;
}

beforeEach(() => {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  delete process.env.DEMO_MODE;
  // Pins the wall clock (month of the paystub range, "today" for bandwidth); timers stay real.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

describe('Storj lifetime totals', () => {
  it('count paid and the held balance once, add the open month and keep distributed apart', async () => {
    configure('192.0.2.30:14002');
    mockFetch({ 'http://192.0.2.30:14002': nodeRoute() });

    const summary = await fetchSummary();
    const total = ok(summary.nodes[0]).total;

    expect(total.netUsd).toBeCloseTo(4.25 + 8.4, 9);
    expect(total.heldUsd).toBeCloseTo(3.5 - 2 + 2.1, 9);
    expect(total.grossUsd).toBeCloseTo(4.25 + 1.5 + 10.5, 9);
    expect(total.grossUsd).toBeCloseTo(total.netUsd + total.heldUsd, 9);
    expect(total.distributedUsd).toBeCloseTo(10.45, 9);
    expect(total.isPartial).toBe(false);
    expect(summary.aggregate.total.grossUsd).toBeCloseTo(total.grossUsd, 9);
    expect(summary.aggregate.total.isPartial).toBe(false);
  });

  it('are marked partial (previous + current month) when the paystub request fails', async () => {
    configure('192.0.2.30:14002');
    const requested = mockFetch({
      'http://192.0.2.30:14002': nodeRoute({
        '/api/heldamount/paystubs/': () => json({ error: 'busy' }, 503),
      }),
    });

    const summary = await fetchSummary();
    const node = ok(summary.nodes[0]);

    expect(node.total.isPartial).toBe(true);
    expect(node.total.netUsd).toBeCloseTo(12 + 8.4, 9);
    expect(node.total.heldUsd).toBeCloseTo(3 + 2.1, 9);
    expect(node.total.grossUsd).toBeCloseTo(15 + 10.5, 9);
    expect(summary.aggregate.total.isPartial).toBe(true);
    expect(requested).toContain('http://192.0.2.30:14002/api/heldamount/paystubs/2019-01/2026-10');
  });

  it('count a new node in full: storagenode answers null for a range without paystubs', async () => {
    configure('192.0.2.30:14002');
    mockFetch({
      'http://192.0.2.30:14002': nodeRoute({ '/api/heldamount/paystubs/': noPaystubs }),
    });

    const summary = await fetchSummary();
    const total = ok(summary.nodes[0]).total;

    // The previous and the current month's estimates, nothing else to wait for.
    expect(total.netUsd).toBeCloseTo(12 + 8.4, 9);
    expect(total.grossUsd).toBeCloseTo(15 + 10.5, 9);
    expect(total.distributedUsd).toBe(0);
    expect(total.isPartial).toBe(false);
    expect(summary.aggregate.total.isPartial).toBe(false);
  });

  it('never turn a non-numeric amount into NaN or a coerced boolean', async () => {
    configure('192.0.2.30:14002');
    mockFetch({
      'http://192.0.2.30:14002': nodeRoute({
        '/api/sno/estimated-payout': () =>
          json({
            currentMonth: { ...ESTIMATED_PAYOUT.currentMonth, held: { value: 210 }, payout: true },
          }),
        '/api/heldamount/paystubs/': noPaystubs,
      }),
    });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.current.heldUsd).toBe(0);
    expect(node.current.netUsd).toBe(0);
    expect(Number.isNaN(node.total.heldUsd)).toBe(false);
  });
});

describe('Storj bandwidth change', () => {
  it('compares the last two complete UTC days, not the partial day', async () => {
    configure('192.0.2.30:14002');
    mockFetch({ 'http://192.0.2.30:14002': nodeRoute() });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.bandwidth?.totalBytes).toBe(248_000_000_000);
    expect(node.bandwidth?.changeTotalBytes).toBe(97_000_000_002);
    expect(node.bandwidth?.changeSampleHours).toBe(24);
    expect(node.bandwidth?.changeDayStart).toBe('2026-10-24T00:00:00Z');
  });
});

describe('Storj node addresses', () => {
  it('build every request from the configured scheme, host and port', async () => {
    configure('https://storj.example:14002', '[fd00::30]:14002');
    const requested = mockFetch({
      'https://storj.example:14002': nodeRoute(),
      'http://[fd00::30]:14002': nodeRoute(),
    });

    const summary = await fetchSummary();

    expect(summary.nodes.map((node) => node.status)).toEqual(['ok', 'ok']);
    expect(requested.filter((url) => url.startsWith('https://storj.example:14002'))).toEqual([
      'https://storj.example:14002/api/sno/estimated-payout',
      'https://storj.example:14002/api/heldamount/paystubs/2019-01/2026-10',
      'https://storj.example:14002/api/sno/',
      'https://storj.example:14002/api/sno/satellites',
    ]);
    expect(requested).toContain('http://[fd00::30]:14002/api/sno/estimated-payout');
    expect(summary.nodes[0].baseUrl).toBe('https://storj.example:14002');
  });

  it("request a scheme without a port on the scheme's default port", async () => {
    configure('https://storj.example', 'http://192.0.2.31/');
    // URL origins leave the default port out.
    const requested = mockFetch({
      'https://storj.example': nodeRoute(),
      'http://192.0.2.31': nodeRoute(),
    });

    const summary = await fetchSummary();

    expect(summary.nodes.map((node) => node.status)).toEqual(['ok', 'ok']);
    expect(requested).toContain('https://storj.example:443/api/sno/estimated-payout');
    expect(requested).toContain('http://192.0.2.31:80/api/sno/estimated-payout');
    expect(summary.nodes.map((node) => node.baseUrl)).toEqual([
      'https://storj.example:443',
      'http://192.0.2.31:80',
    ]);
    // The address is shown as configured.
    expect(summary.nodes.map((node) => node.host)).toEqual([
      'https://storj.example',
      'http://192.0.2.31/',
    ]);
  });
});

describe('Storj node addresses that do not parse', () => {
  it.each([
    'user:secretpw@192.0.2.30:14002',
    '192.0.2.30',
    '192.0.2.30:14002/sub',
    // Pass the address grammar, but fetch rejects them.
    '192.0.2.300:14002',
    'https://192.0.2.300',
  ])(
    '%p is misconfigured, never requested, and no password reaches the summary',
    async (address) => {
      configure(address);
      const requested = mockFetch({ 'http://192.0.2.30:14002': nodeRoute() });

      const summary = await fetchSummary();

      expect(requested).toEqual([]);
      expect(summary.nodes[0]).toMatchObject({
        status: 'error',
        errorKind: 'invalid_endpoint',
        health: 'misconfigured',
      });
      expect(summary.nodes[0].baseUrl).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('secretpw');
      // The help text reaches the API whole, https example included.
      expect(summary.nodes[0]).toMatchObject({
        message: 'Invalid node address: use host:port, https://host:port or [IPv6]:port',
      });
    },
  );
});

describe('Storj aggregate lifetime', () => {
  it('is partial when a node failed and is left out of the sums', async () => {
    configure('192.0.2.30:14002', '192.0.2.31:14002');
    mockFetch({ 'http://192.0.2.30:14002': nodeRoute() });

    const summary = await fetchSummary();

    expect(ok(summary.nodes[0]).total.isPartial).toBe(false);
    expect(summary.nodes[1].status).toBe('error');
    expect(summary.aggregate.total.netUsd).toBeCloseTo(ok(summary.nodes[0]).total.netUsd, 9);
    expect(summary.aggregate.total.isPartial).toBe(true);
  });

  it('is complete when every node answered with its whole history', async () => {
    configure('192.0.2.30:14002', '192.0.2.31:14002');
    mockFetch({
      'http://192.0.2.30:14002': nodeRoute(),
      'http://192.0.2.31:14002': nodeRoute(),
    });

    const summary = await fetchSummary();

    expect(summary.aggregate.total.netUsd).toBeCloseTo(2 * (4.25 + 8.4), 9);
    expect(summary.aggregate.total.isPartial).toBe(false);
  });
});

describe('Storj node failures', () => {
  it('a refused connection is offline, classified by error code', async () => {
    configure('192.0.2.31:14002');
    mockFetch({});

    const [node] = (await fetchSummary()).nodes;

    expect(node).toMatchObject({ status: 'error', errorKind: 'unreachable', health: 'offline' });
    expect((node as { message: string }).message).toBe('connect ECONNREFUSED 192.0.2.31:14002');
  });

  it('a payload without currentMonth is misconfigured', async () => {
    configure('192.0.2.30:14002');
    mockFetch({
      'http://192.0.2.30:14002': nodeRoute({
        '/api/sno/estimated-payout': () => json({ previousMonth: {} }),
      }),
    });

    const [node] = (await fetchSummary()).nodes;

    expect(node).toMatchObject({
      status: 'error',
      errorKind: 'invalid_response',
      health: 'misconfigured',
      message: 'Response missing currentMonth data',
    });
  });

  it('a node that never answers times out instead of hanging the summary', async () => {
    process.env.NODE_REQUEST_TIMEOUT_MS = '50';
    configure('192.0.2.32:14002');
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;

    try {
      const [node] = (await fetchSummary()).nodes;
      expect(node).toMatchObject({ status: 'error', errorKind: 'timeout', health: 'offline' });
    } finally {
      delete process.env.NODE_REQUEST_TIMEOUT_MS;
    }
  }, 2_000);
});

describe('Storj demo mode', () => {
  it('answers without requests, with dashboard links, distributed and the change day', async () => {
    process.env.DEMO_MODE = 'true';
    const requested = mockFetch({});
    try {
      const summary = await fetchSummary();

      expect(requested).toEqual([]);
      expect(summary.nodes.map((node) => node.baseUrl)).toEqual([
        'http://demo-storj-1.example.com:14002',
        'http://demo-storj-2.example.com:14003',
        'http://demo-storj-3.example.com:14004',
      ]);
      expect(ok(summary.nodes[0]).bandwidth?.changeDayStart).toBe('2026-10-24T00:00:00Z');
      expect(summary.aggregate.bandwidth?.changeDayStart).toBe('2026-10-24T00:00:00Z');
      expect(summary.aggregate.total.distributedUsd).toBe(485);
      // The offline demo node is not in the sums, as with a failed live node.
      expect(summary.nodes[2].status).toBe('error');
      expect(summary.aggregate.total.isPartial).toBe(true);
    } finally {
      delete process.env.DEMO_MODE;
    }
  });
});
