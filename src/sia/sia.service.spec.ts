import { Logger } from '@nestjs/common';
import { SiaService } from './sia.service';
import { SiaNodeStatus, SiaNodeSuccess, SiaSummary } from './sia.types';

// The real runtime-env reads ./.env (real node hosts and passwords); tests use their own config.
const mockEnv: Record<string, string | undefined> = {};
jest.mock('../runtime-env', () => ({
  getRuntimeEnv: (name: string) => mockEnv[name],
}));

const originalFetch = global.fetch;
const SC = '000000000000000000000000';
const AUTH = `Basic ${Buffer.from(':secret', 'utf8').toString('base64')}`;

/** One hostd `/api/metrics` entry; money values are hastings (1 SC = 1e24 H). */
function metric(timestamp: string, earnedStorageSc: number, contracts: object = { active: 10 }) {
  return {
    revenue: {
      potential: { storage: `${earnedStorageSc}${SC}` },
      earned: { storage: `${earnedStorageSc}${SC}` },
    },
    contracts,
    storage: { totalSectors: 1000, physicalSectors: 400 },
    wallet: { balance: `1000${SC}`, immatureBalance: '0' },
    timestamp,
  };
}

const MONTHLY = [
  metric('2026-09-01T00:00:00Z', 1),
  metric('2026-10-01T00:00:00Z', 3, { active: 12, lockedCollateral: `250${SC}` }),
];

// hostd GET /api/wallet (coreutils wallet.Balance plus the address), hastings strings.
const HOSTD_WALLET = {
  spendable: `900${SC}`,
  confirmed: `1000${SC}`,
  unconfirmed: `25${SC}`,
  immature: `50${SC}`,
  address: 'addr:00000000000000000000000000000000000000000000000000000000000000000089eb0d6a8a69',
};

interface RecordedRequest {
  url: string;
  method: string;
  authorization?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers a request for `path`; `url` is the whole request URL (mockFetch passes it). */
type Route = (path: string, url?: URL) => Response;

/** hostd: monthly metrics and the given wallet reply; every other call answers 503. */
function hostdRoute(walletReply: () => Response = () => json(HOSTD_WALLET)): Route {
  return (path) => {
    if (path === '/api/metrics/monthly') return json(MONTHLY);
    if (path === '/api/wallet') return walletReply();
    if (path === '/wallet') return new Response('<!doctype html><title>hostd</title>');
    if (path === '/api/settings/announce') return json(null);
    return json({ error: 'unavailable' }, 503);
  };
}

/** Routes by URL origin; records every request. An unknown origin refuses the connection. */
function mockFetch(routes: Record<string, Route>): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, method: init?.method ?? 'GET', authorization: headers.Authorization });
    const parsed = new URL(url);
    const route = routes[parsed.origin];
    if (!route) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${parsed.host}`), {
          code: 'ECONNREFUSED',
        }),
      });
    }
    return route(parsed.pathname, parsed);
  }) as unknown as typeof fetch;
  return requests;
}

function configure(...nodes: Array<{ host: string; walletHost?: string }>): void {
  mockEnv.SIA_NODES_JSON = JSON.stringify(nodes.map((node) => ({ password: 'secret', ...node })));
}

async function fetchSummary(): Promise<SiaSummary> {
  return new SiaService().fetchSummary();
}

function ok(node: SiaNodeStatus): SiaNodeSuccess {
  expect(node.status).toBe('ok');
  return node as SiaNodeSuccess;
}

beforeEach(() => {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  delete process.env.DEMO_MODE;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('Sia wallet', () => {
  it("comes from hostd's /api/wallet, not the /wallet UI page", async () => {
    configure({ host: '192.0.2.40:9980' });
    const requests = mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.wallet?.confirmed).toBeCloseTo(1000, 9);
    expect(node.wallet?.spendable).toBeCloseTo(900, 9);
    expect(node.wallet?.unconfirmedIncoming).toBeCloseTo(25, 9);
    // Confirmed but not spendable: reserved or spent by pool transactions.
    expect(node.wallet?.unconfirmedOutgoing).toBeCloseTo(100, 9);
    expect(node.wallet?.immature).toBeCloseTo(50, 9);
    expect(node.wallet?.lockedCollateral).toBeCloseTo(250, 9);
    const wallet = requests.find((request) => request.url.endsWith('/api/wallet'));
    expect(wallet?.authorization).toBe(AUTH);
    expect(requests.some((request) => request.url.endsWith(':9980/wallet'))).toBe(false);
  });

  it('a reply without balances falls back to the metrics balance instead of 0 SC', async () => {
    configure({ host: '192.0.2.40:9980' });
    // JSON on every wallet path, but none of the balance keys.
    const noBalances = () => json({ address: HOSTD_WALLET.address });
    mockFetch({
      'http://192.0.2.40:9980': (path) =>
        path === '/wallet' ? noBalances() : hostdRoute(noBalances)(path),
    });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.wallet?.confirmed).toBeCloseTo(1000, 9);
    expect(node.wallet?.spendable).toBeCloseTo(1000, 9);
    expect(node.wallet?.lockedCollateral).toBeCloseTo(250, 9);
  });

  it('a configured walletHost is asked first with its own keys', async () => {
    configure({ host: '192.0.2.40:9980', walletHost: 'wallet.example:9990' });
    mockFetch({
      'http://192.0.2.40:9980': hostdRoute(),
      'http://wallet.example:9990': (path) =>
        path === '/wallet'
          ? json({
              confirmedSiacoinBalance: `5000${SC}`,
              spendableSiacoinBalance: `4000${SC}`,
              unconfirmedIncomingSiacoinBalance: `7${SC}`,
              unconfirmedOutgoingSiacoinBalance: `2${SC}`,
            })
          : json({}, 404),
    });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.wallet?.confirmed).toBeCloseTo(5000, 9);
    expect(node.wallet?.spendable).toBeCloseTo(4000, 9);
    expect(node.wallet?.unconfirmedIncoming).toBeCloseTo(7, 9);
    expect(node.wallet?.unconfirmedOutgoing).toBeCloseTo(2, 9);
  });

  it('an unreachable walletHost falls back to hostd', async () => {
    configure({ host: '192.0.2.40:9980', walletHost: 'https://wallet.example:9990' });
    mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });

    const node = ok((await fetchSummary()).nodes[0]);

    expect(node.wallet?.spendable).toBeCloseTo(900, 9);
  });

  it.each(['wallet.example', 'https://wallet.example/api', 'user:walletpw@wallet.example:9990'])(
    'a walletHost %p that does not parse falls back to hostd and is logged once, value left out',
    async (walletHost) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        configure({ host: '192.0.2.40:9980', walletHost });
        const requests = mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });
        const service = new SiaService();

        const first = ok((await service.fetchSummary()).nodes[0]);
        await service.fetchSummary();

        expect(first.wallet?.spendable).toBeCloseTo(900, 9);
        expect(requests.every((request) => request.url.startsWith('http://192.0.2.40:9980/'))).toBe(
          true,
        );
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        expect(message).toBe(
          'walletHost of Sia node 192.0.2.40:9980 is not used: Invalid node address: use ' +
            "host:port, https://host:port or [IPv6]:port. The wallet shown is hostd's.",
        );
        expect(String(message)).not.toContain('wallet.example');
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('an unreachable walletHost is not logged as a config mistake', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      configure({ host: '192.0.2.40:9980', walletHost: 'wallet.example:9990' });
      mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });

      ok((await fetchSummary()).nodes[0]);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Sia node addresses', () => {
  it('build every request from the configured scheme, host and port', async () => {
    configure({ host: 'https://sia.example:9980' }, { host: '[fd00::40]:9980' });
    const requests = mockFetch({
      'https://sia.example:9980': hostdRoute(),
      'http://[fd00::40]:9980': hostdRoute(),
    });

    const summary = await fetchSummary();

    expect(summary.nodes.map((node) => node.status)).toEqual(['ok', 'ok']);
    const tls = requests.filter((request) => request.url.includes('sia.example'));
    expect(tls.map((request) => new URL(request.url).pathname).sort()).toEqual([
      '/api/metrics',
      '/api/metrics/15m',
      '/api/metrics/daily',
      '/api/metrics/monthly',
      '/api/wallet',
    ]);
    expect(tls.every((request) => request.url.startsWith('https://sia.example:9980/api/'))).toBe(
      true,
    );
    expect(requests.every((request) => request.authorization === AUTH)).toBe(true);
    expect(
      requests.some((request) =>
        request.url.startsWith('http://[fd00::40]:9980/api/metrics/monthly?start='),
      ),
    ).toBe(true);
    expect(summary.nodes[0].baseUrl).toBe('https://sia.example:9980');
  });

  it('an https host without a port is requested on port 443, password included', async () => {
    configure({ host: 'https://sia.example' });
    const requests = mockFetch({ 'https://sia.example': hostdRoute() });

    const summary = await fetchSummary();

    expect(summary.nodes[0].status).toBe('ok');
    expect(requests.length).toBeGreaterThan(0);
    // An origin without a port is the scheme's default one (metric URLs drop the ":443").
    expect(new Set(requests.map((request) => new URL(request.url).origin))).toEqual(
      new Set(['https://sia.example']),
    );
    expect(requests.every((request) => request.authorization === AUTH)).toBe(true);
    expect(summary.nodes[0].baseUrl).toBe('https://sia.example:443');
  });

  it('announce posts to the node base URL', async () => {
    configure({ host: 'https://sia.example:9980' });
    const requests = mockFetch({ 'https://sia.example:9980': hostdRoute() });

    await new SiaService().announceHost('https://sia.example:9980');

    expect(requests).toEqual([
      {
        url: 'https://sia.example:9980/api/settings/announce',
        method: 'POST',
        authorization: AUTH,
      },
    ]);
  });
});

describe('Sia node addresses that do not parse', () => {
  it('a host with user credentials is misconfigured, never requested, and its password stays out', async () => {
    configure({ host: 'admin:secretpw@192.0.2.40:9980' });
    const requests = mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });

    const summary = await fetchSummary();

    expect(requests).toEqual([]);
    expect(summary.nodes[0]).toMatchObject({
      host: '***@192.0.2.40:9980',
      status: 'error',
      errorKind: 'invalid_endpoint',
      health: 'misconfigured',
      message: 'Invalid node address: use host:port, https://host:port or [IPv6]:port',
    });
    expect(JSON.stringify(summary)).not.toContain('secretpw');
  });

  it.each(['192.0.2.300:9980', 'https://192.0.2.300', 'https://sia.example.123'])(
    '%p, which fetch rejects, is misconfigured like any unreadable address and has no link',
    async (address) => {
      configure({ host: address });
      const requests = mockFetch({});

      const [node] = (await fetchSummary()).nodes;

      expect(requests).toEqual([]);
      expect(node).toMatchObject({
        host: address,
        status: 'error',
        errorKind: 'invalid_endpoint',
        health: 'misconfigured',
        message: 'Invalid node address: use host:port, https://host:port or [IPv6]:port',
      });
      expect(node.baseUrl).toBeUndefined();
    },
  );
});

describe('Sia node failures', () => {
  it('a malformed SIA_METRICS_BASE_URL is an invalid endpoint, not an unknown failure', async () => {
    configure({ host: '192.0.2.40:9980' });
    mockEnv.SIA_METRICS_BASE_URL = 'not a url';
    mockFetch({ 'http://192.0.2.40:9980': hostdRoute() });

    const [node] = (await fetchSummary()).nodes;

    expect(node).toMatchObject({
      status: 'error',
      errorKind: 'invalid_endpoint',
      health: 'misconfigured',
      message: 'Invalid SIA_METRICS_BASE_URL',
    });
  });

  it('a refused password is misconfigured with an unauthorized kind', async () => {
    configure({ host: '192.0.2.40:9980' });
    mockFetch({ 'http://192.0.2.40:9980': () => json({ error: 'unauthorized' }, 401) });

    const [node] = (await fetchSummary()).nodes;

    expect(node).toMatchObject({
      status: 'error',
      errorKind: 'unauthorized',
      health: 'misconfigured',
    });
    expect((node as { message: string }).message).not.toContain('192.0.2.40');
  });

  it('a refused connection is offline', async () => {
    configure({ host: '192.0.2.41:9980' });
    mockFetch({});

    const [node] = (await fetchSummary()).nodes;

    expect(node).toMatchObject({ status: 'error', errorKind: 'unreachable', health: 'offline' });
  });
});

describe('Sia calendar period', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-10-28T12:00:00Z'),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each<[string, string, string, { month?: string } | undefined]>([
    ['no month', 'Current month', 'Current', undefined],
    ['the running month', 'Current month', 'Current', { month: '2026-10' }],
    ['a past month', 'September 2026', 'Sep 2026', { month: '2026-09' }],
    ['a month of a past year', 'December 2025', 'Dec 2025', { month: '2025-12' }],
  ])('labels %s %p', async (_name, periodLabel, periodShortLabel, options) => {
    // No node configured: the summary is only its period.
    mockFetch({});

    const summary = await new SiaService().fetchSummary(options);

    expect(summary).toMatchObject({ periodMode: 'calendar', periodLabel, periodShortLabel });
  });
});

/**
 * hostd stamps each `/api/metrics/:period` entry with the start of its period and fills it with the
 * last totals recorded in that period (`PeriodMetrics` in hostd's persist/sqlite/metrics.go): the
 * totals at the end of the period, or now for the period still running. These summaries come from
 * a hostd whose totals grow evenly, so every figure has to be the growth between the two instants
 * its window runs between.
 */
describe('Sia hostd periods', () => {
  type Range = '1d' | '7d' | '1m' | '3m' | '1y' | 'all';

  const NOW = Date.parse('2026-10-28T12:00:00Z');
  const MONTH_START = Date.parse('2026-10-01T00:00:00Z');
  const GROWTH_START = Date.parse('2025-01-01T00:00:00Z');
  const QUARTER_HOUR = 15 * 60 * 1000;
  const HOUR = 4 * QUARTER_HOUR;
  const DAY = 24 * HOUR;
  const SECTOR_BYTES = 4 * 1024 * 1024;

  // Per quarter hour 0.25 SC of storage revenue and one more stored sector; one more active
  // contract every six hours.
  const quarterHours = (at: number) => Math.max(0, Math.floor((at - GROWTH_START) / QUARTER_HOUR));
  const contracts = (at: number) => Math.floor(quarterHours(at) / 24);
  const earnedBetween = (from: number, to: number) => (quarterHours(to) - quarterHours(from)) / 4;
  const bytesBetween = (from: number, to: number) =>
    (quarterHours(to) - quarterHours(from)) * SECTOR_BYTES;

  function entry(timestamp: number, asOf: number) {
    const stored = quarterHours(asOf);
    // 0.25 SC is 25 * 10^22 hastings.
    const earned = stored === 0 ? '0' : `${stored * 25}${'0'.repeat(22)}`;
    return {
      revenue: { potential: { storage: earned }, earned: { storage: earned } },
      contracts: { active: contracts(asOf) },
      storage: { totalSectors: 1_000_000, physicalSectors: stored },
      wallet: { balance: '0', immatureBalance: '0' },
      timestamp: new Date(timestamp).toISOString().replace(/\.000Z$/, 'Z'),
    };
  }

  /** `start` normalised to its period, in UTC like a `Z` start; weeks start on Sunday. */
  function periodStart(period: string, start: number): number {
    const date = new Date(start);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
    switch (period) {
      case '15m':
        return start - (start % QUARTER_HOUR);
      case 'hourly':
        return start - (start % HOUR);
      case 'daily':
        return Date.UTC(year, month, day);
      case 'weekly':
        return Date.UTC(year, month, day - date.getUTCDay());
      case 'monthly':
        return Date.UTC(year, month, 1);
    }
    throw new Error(`hostd has no ${period} metrics`);
  }

  function nextPeriod(period: string, at: number): number {
    switch (period) {
      case '15m':
        return at + QUARTER_HOUR;
      case 'hourly':
        return at + HOUR;
      case 'daily':
        return at + DAY;
      case 'weekly':
        return at + 7 * DAY;
      case 'monthly': {
        const date = new Date(at);
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      }
    }
    throw new Error(`hostd has no ${period} metrics`);
  }

  /**
   * The periods from `first` that hostd returns when it counts them itself
   * (handleGETPeriodMetrics in hostd's api/endpoints.go): up to the date of a server
   * `serverUtcOffsetHours` from UTC, daily and monthly through that date, weekly through that date
   * plus its weekday (Sunday 0), so from Thursday on through next Sunday.
   */
  function serverPeriodCount(
    period: string,
    first: number,
    now: number,
    serverUtcOffsetHours: number,
  ): number {
    const server = new Date(now + serverUtcOffsetHours * HOUR);
    const serverDay = Date.UTC(server.getUTCFullYear(), server.getUTCMonth(), server.getUTCDate());
    const last =
      period === '15m' || period === 'hourly'
        ? periodStart(period, now)
        : period === 'weekly'
          ? serverDay + server.getUTCDay() * DAY
          : serverDay;
    let count = 0;
    for (let at = first; at <= last; at = nextPeriod(period, at)) count += 1;
    return count;
  }

  /**
   * `periods` entries from `start` (or as many as hostd counts itself), each holding the totals at
   * its end, or at `now` for the running period and any after it.
   */
  function periodMetrics(
    period: string,
    start: number,
    periods: number | undefined,
    now: number,
    serverUtcOffsetHours: number,
  ) {
    const first = periodStart(period, start);
    const count = periods ?? serverPeriodCount(period, first, now, serverUtcOffsetHours);
    const entries = [];
    for (let at = first; entries.length < count; at = nextPeriod(period, at)) {
      entries.push(entry(at, Math.min(nextPeriod(period, at), now)));
    }
    return entries;
  }

  interface HostdOptions {
    /** Metrics periods that answer 503. */
    failing?: string[];
    /** Where the daily series starts; it then runs to today. */
    dailyFrom?: string;
    /** The time at the node and the dashboard; NOW by default. */
    now?: number;
    serverUtcOffsetHours?: number;
  }

  function growingHostd(options: HostdOptions): Route {
    const now = options.now ?? NOW;
    const offset = options.serverUtcOffsetHours ?? 0;
    return (path, url) => {
      if (path === '/api/metrics') return json(entry(now, now));
      const period = path.startsWith('/api/metrics/') ? path.slice('/api/metrics/'.length) : '';
      // `/api/wallet` too: the metrics balance stands in.
      if (!period || options.failing?.includes(period)) return json({ error: 'unavailable' }, 503);
      if (period === 'daily' && options.dailyFrom) {
        return json(periodMetrics(period, Date.parse(options.dailyFrom), undefined, now, 0));
      }
      const periods = url?.searchParams.get('periods');
      return json(
        periodMetrics(
          period,
          Date.parse(url?.searchParams.get('start') ?? ''),
          periods ? Number(periods) : undefined,
          now,
          offset,
        ),
      );
    };
  }

  async function summary(
    range?: Range | { month: string },
    options: HostdOptions = {},
  ): Promise<SiaNodeSuccess> {
    jest.setSystemTime(options.now ?? NOW);
    configure({ host: '192.0.2.40:9980' });
    mockFetch({ 'http://192.0.2.40:9980': growingHostd(options) });
    const query = typeof range === 'string' ? { range } : range;
    return ok((await new SiaService().fetchSummary(query)).nodes[0]);
  }

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each<[string, Range | undefined]>([
    ['the month view', undefined],
    ['1d', '1d'],
    ['7d', '7d'],
    ['1m', '1m'],
    ['3m', '3m'],
    ['1y', '1y'],
    ['all', 'all'],
  ])('%s counts the current month from its first midnight', async (_name, range) => {
    const node = await summary(range);

    expect(node.totals.currentMonth?.earned).toBeCloseTo(earnedBetween(MONTH_START, NOW), 9);
    expect(node.storage?.changeMonthCalendarBytes).toBe(bytesBetween(MONTH_START, NOW));
  });

  // The period boundary at or before now minus the range, in each range's own series: hourly for
  // 1d (now - 24 h is an hour boundary), daily for 7d, 1m and 3m (now - 7 d is 21 Oct 12:00),
  // weekly from Sundays for 1y (now - 365 d is Tuesday 28 Oct 2025).
  it.each<[Range, string]>([
    ['1d', '2026-10-27T12:00:00Z'],
    ['7d', '2026-10-21T00:00:00Z'],
    ['1m', '2026-09-28T00:00:00Z'],
    ['3m', '2026-07-30T00:00:00Z'],
    ['1y', '2025-10-26T00:00:00Z'],
  ])(
    '%s counts revenue and contracts from %s, the last period end at or before its start',
    async (range, start) => {
      const node = await summary(range);
      const from = Date.parse(start);

      expect(node.totals.current.earned).toBeCloseTo(earnedBetween(from, NOW), 9);
      expect(node.contracts?.active.deltaCount).toBe(contracts(NOW) - contracts(from));
    },
  );

  it('storage changes cover their whole window', async () => {
    const storage = (await summary('7d')).storage;

    expect(storage?.changeDayBytes).toBe(bytesBetween(NOW - DAY, NOW));
    expect(storage?.changeDaySampleHours).toBe(24);
    expect(storage?.changeMonthBytes).toBe(bytesBetween(NOW - 30 * DAY, NOW));
    expect(storage?.changeMonthBaselineStart).toBe('2026-09-28T00:00:00Z');
    expect(storage?.changeRangeBytes).toBe(bytesBetween(NOW - 7 * DAY, NOW));
    expect(storage?.changeRangeSampleHours).toBe(168);
  });

  it.each<[Range, number]>([
    ['1d', 1],
    ['1m', 30],
    ['3m', 90],
    ['1y', 365],
  ])('the %s storage change covers %p days', async (range, days) => {
    const storage = (await summary(range)).storage;

    expect(storage?.changeRangeBytes).toBe(bytesBetween(NOW - days * DAY, NOW));
  });

  // 1d's own hourly series starts 30 hours ago, after the month's first midnight, and 1y's weekly
  // entries end on Sundays: the last one before Thursday 1 Oct ends on 27 Sep.
  it.each<[Range]>([['1d'], ['1y'], ['all']])(
    'without the daily totals %s counts the current month from the monthly ones',
    async (range) => {
      const node = await summary(range, { failing: ['daily'] });

      expect(node.totals.currentMonth?.earned).toBeCloseTo(earnedBetween(MONTH_START, NOW), 9);
    },
  );

  it('without daily and monthly totals 1d leaves the current month unknown', async () => {
    // Its hourly series starts 30 hours ago: those totals would pass for the month's.
    jest.setSystemTime(NOW);
    configure({ host: '192.0.2.40:9980' });
    mockFetch({ 'http://192.0.2.40:9980': growingHostd({ failing: ['daily', 'monthly'] }) });

    const result = await new SiaService().fetchSummary({ range: '1d' });

    expect(ok(result.nodes[0]).totals.currentMonth).toBeUndefined();
    expect(result.aggregate.currentMonth).toBeUndefined();
  });

  it('a history that begins within the month counts the month from its first totals', async () => {
    // The first daily entry, stamped 10 Oct, holds the totals at the end of that day.
    const node = await summary('1d', { failing: ['monthly'], dailyFrom: '2026-10-10T00:00:00Z' });

    expect(node.totals.currentMonth?.earned).toBeCloseTo(
      earnedBetween(Date.parse('2026-10-11T00:00:00Z'), NOW),
      9,
    );
  });

  it('with weekly totals only the current month counts from the last Sunday before the 1st', async () => {
    const node = await summary('1y', { failing: ['daily', 'monthly'] });

    expect(node.totals.currentMonth?.earned).toBeCloseTo(
      earnedBetween(Date.parse('2026-09-27T00:00:00Z'), NOW),
      9,
    );
  });

  describe('a server west of UTC still reports the UTC day that has begun', () => {
    // 21:30 on 28 Oct at the server: counted to its own date, the daily series would end with
    // 28 Oct, so every daily figure would stop at the UTC midnight 2.5 hours ago.
    const west = { now: Date.parse('2026-10-29T02:30:00Z'), serverUtcOffsetHours: -5 };

    it.each<[string, Range | undefined]>([
      ['the month view', undefined],
      ['1d', '1d'],
      ['7d', '7d'],
      ['1m', '1m'],
      ['3m', '3m'],
      ['1y', '1y'],
      ['all', 'all'],
    ])('%s counts the current month to now', async (_name, range) => {
      const node = await summary(range, west);

      expect(node.totals.currentMonth?.earned).toBeCloseTo(earnedBetween(MONTH_START, west.now), 9);
    });

    it('7d counts revenue to now', async () => {
      const node = await summary('7d', west);

      // From the daily entry that ends at 22 Oct 00:00, the last end at or before 22 Oct 02:30.
      expect(node.totals.current.earned).toBeCloseTo(
        earnedBetween(Date.parse('2026-10-22T00:00:00Z'), west.now),
        9,
      );
    });
  });

  it('a server east of UTC adds no daily entry for tomorrow', async () => {
    // 00:30 on 29 Oct at the server: counted to its own date, the daily series would end with an
    // entry stamped 29 Oct, and the 30-day change would be measured back from that midnight.
    const now = Date.parse('2026-10-28T22:30:00Z');
    const storage = (await summary('7d', { now, serverUtcOffsetHours: 2 })).storage;

    expect(storage?.changeMonthBytes).toBe(bytesBetween(now - 30 * DAY, now));
    expect(storage?.changeRangeBytes).toBe(bytesBetween(now - 7 * DAY, now));
  });

  it('a weekly series asked on a Thursday ends with this week', async () => {
    // Counted by hostd itself, from Thursday to Saturday the weekly series also holds next
    // Sunday's entry (1 Nov), and the year's storage change would be measured back from it.
    const now = Date.parse('2026-10-29T12:00:00Z');
    const storage = (await summary('1y', { now })).storage;

    expect(storage?.changeRangeBytes).toBe(bytesBetween(now - 365 * DAY, now));
    expect(storage?.changeRangeSampleHours).toBe(365 * 24);
  });

  it('the running month asked by name asks for no period that has not begun', async () => {
    // Its requests end on 1 Nov: hostd would fill the days still ahead with today's totals.
    configure({ host: '192.0.2.40:9980' });
    const requests = mockFetch({ 'http://192.0.2.40:9980': growingHostd({}) });

    ok((await new SiaService().fetchSummary({ month: '2026-10' })).nodes[0]);

    const lastPeriods = requests
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname.startsWith('/api/metrics/'))
      // hostd refuses a start in the future, the 15m request's here (30 hours before 1 Nov).
      .filter((url) => Date.parse(url.searchParams.get('start') ?? '') <= NOW)
      .map((url) => {
        const period = url.pathname.slice('/api/metrics/'.length);
        let last = periodStart(period, Date.parse(url.searchParams.get('start') ?? ''));
        for (let i = 1; i < Number(url.searchParams.get('periods')); i += 1) {
          last = nextPeriod(period, last);
        }
        return [period, new Date(last).toISOString()];
      });
    expect(lastPeriods).toEqual([
      ['monthly', '2026-10-01T00:00:00.000Z'],
      ['daily', '2026-10-28T00:00:00.000Z'],
    ]);
  });

  it('a past month counts its own revenue, not the running month', async () => {
    // A month view's request ends on the next 1st; hostd would count on to the running month.
    const node = await summary({ month: '2026-09' });

    expect(node.totals.current.earned).toBeCloseTo(
      earnedBetween(Date.parse('2026-09-01T00:00:00Z'), MONTH_START),
      9,
    );
  });

  it('without the quarter hour totals the day change still covers 24 hours', async () => {
    const storage = (await summary('7d', { failing: ['15m'] })).storage;

    expect(storage?.changeDayBytes).toBe(bytesBetween(NOW - DAY, NOW));
    expect(storage?.changeDaySampleHours).toBe(24);
  });

  it('a day change from the two newest daily totals spans the hours since midnight', async () => {
    // Yesterday's and today's entries only: nothing is known about the node 24 hours ago.
    const storage = (await summary('7d', { failing: ['15m'], dailyFrom: '2026-10-27T00:00:00Z' }))
      .storage;

    expect(storage?.changeDayBytes).toBe(bytesBetween(Date.parse('2026-10-28T00:00:00Z'), NOW));
    expect(storage?.changeDaySampleHours).toBe(12);
  });
});

describe('Sia demo mode', () => {
  type SummaryOptions = Parameters<SiaService['fetchSummary']>[0];

  const periodOf = (summary: SiaSummary) => ({
    periodStart: summary.periodStart,
    periodEnd: summary.periodEnd,
    periodMode: summary.periodMode,
    periodLabel: summary.periodLabel,
    periodShortLabel: summary.periodShortLabel,
    previousPeriodStart: summary.previousPeriodStart,
    rollingBaselineStart: summary.rollingBaselineStart,
  });

  async function demoSummary(options: SummaryOptions): Promise<SiaSummary> {
    process.env.DEMO_MODE = 'true';
    try {
      return await new SiaService().fetchSummary(options);
    } finally {
      delete process.env.DEMO_MODE;
    }
  }

  beforeEach(() => {
    // Pins the wall clock only; the period of a range ends now.
    jest.useFakeTimers({
      now: new Date('2026-10-28T12:00:00Z'),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('labels the last 7 days with their own dates, not the calendar month', async () => {
    const requests = mockFetch({});

    const summary = await demoSummary({ range: '7d' });

    expect(requests).toEqual([]);
    expect(periodOf(summary)).toMatchObject({
      periodStart: '2026-10-21T12:00:00Z',
      periodEnd: '2026-10-28T12:00:00Z',
      periodMode: 'range',
      periodLabel: 'Last 7 days',
      periodShortLabel: '7D',
    });
  });

  it.each<[string, SummaryOptions]>([
    ['current month', undefined],
    ['a past month', { month: '2026-09' }],
    ['1d', { range: '1d' }],
    ['7d', { range: '7d' }],
    ['1m', { range: '1m' }],
    ['3m', { range: '3m' }],
    ['1y', { range: '1y' }],
    ['all', { range: 'all' }],
  ])('reports the period a live request has for %s', async (_name, options) => {
    // No node configured: the live summary is only its period.
    const requests = mockFetch({});
    const live = await new SiaService().fetchSummary(options);

    expect(periodOf(await demoSummary(options))).toEqual(periodOf(live));
    expect(requests).toEqual([]);
  });
});
