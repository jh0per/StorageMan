import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { displayNodeHost, nodeBaseUrl } from '../common/node-endpoint';
import {
  hastingsToSiacoins,
  hastingsToSiacoinsOrUndefined,
  toNumberOrUndefined,
} from '../common/node-numbers';
import {
  basicAuthorization,
  getNodeArray,
  getNodeObject,
  invalidResponse,
  NodeRequestError,
  requestNodeText,
  toNodeFailure,
} from '../common/node-request';
import { getRuntimeEnv } from '../runtime-env';
import {
  DEFAULT_DISCOVERY_HOST,
  discoverSiaNodes,
  mergeDiscoveredNodes,
  parseDiscoveryRoots,
  SiaNodeConfig,
} from './sia-discovery';
import {
  SiaContractSummary,
  SiaMetricRow,
  SiaMetricSnapshot,
  SiaNodeStatus,
  SiaStorageUsage,
  SiaSummary,
  SiaWalletSummary,
} from './sia.types';

const RELEVANT_METRICS = new Set(['rpc', 'storage', 'ingress', 'egress']);
const SECTOR_SIZE_BYTES = 4 * 1024 * 1024;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const ROLLING_WINDOW_DAYS = 30;
const ROLLING_WINDOW_BUFFER_DAYS = 2;

type HostdMetricPeriod = '5m' | '15m' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
type SiaSummaryRange = '1d' | '7d' | '1m' | '3m' | '1y' | 'all';

/** Which totals a current month may count from, best first (see `currentMonthInRange`). */
type MonthBaseline = 'atMonthStart' | 'beforeMonthStart' | 'earliest';
const MONTH_BASELINES: MonthBaseline[] = ['atMonthStart', 'beforeMonthStart', 'earliest'];

/** Stored bytes and when they were current. */
interface StoragePoint {
  asOfMs: number;
  usedBytes: number;
}

/**
 * When the totals of the hostd metrics entry stamped `timestampMs` were current. hostd stamps each
 * `/api/metrics/:period` entry with the start of its period and fills it with the last totals
 * recorded in that period (`PeriodMetrics` in hostd's persist/sqlite/metrics.go), so an entry
 * holds the totals as of the end of its period, or as of `nowMs` for the period still running: the
 * daily entry stamped on the 1st holds them at the end of the 1st, and the totals at the 1st's
 * midnight are in the entry of the day before. Every baseline and every storage sample is placed
 * at this time, not at the stamp.
 */
function metricEntryAsOfMs(timestampMs: number, period: HostdMetricPeriod, nowMs: number): number {
  return Math.max(timestampMs, Math.min(metricPeriodEndMs(timestampMs, period), nowMs));
}

/**
 * The `periods` to ask for from `startMs`: how many periods begin before `endMs`, the first one at
 * `startMs` normalised like hostd's `metrics.Normalize` does with a `Z` start (in UTC, weeks from
 * Sunday). Without it hostd counts up to its own local date (handleGETPeriodMetrics), so on a
 * server west of UTC the daily series lacks the UTC day that has begun, east of UTC it holds
 * tomorrow's entry after the server's midnight, and from Thursday to Saturday the weekly series
 * ends with next Sunday's.
 */
function metricPeriodCount(startMs: number, endMs: number, period: HostdMetricPeriod): number {
  let count = 0;
  for (
    let periodStartMs = metricPeriodStartMs(startMs, period);
    periodStartMs < endMs;
    periodStartMs = metricPeriodEndMs(periodStartMs, period)
  ) {
    count += 1;
  }
  return Math.max(count, 1);
}

/** The start of the period `instantMs` falls in, in UTC. */
function metricPeriodStartMs(instantMs: number, period: HostdMetricPeriod): number {
  const date = new Date(instantMs);
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  switch (period) {
    case '5m':
      return instantMs - (instantMs % (5 * MS_PER_MINUTE));
    case '15m':
      return instantMs - (instantMs % (15 * MS_PER_MINUTE));
    case 'hourly':
      return instantMs - (instantMs % MS_PER_HOUR);
    case 'daily':
      return Date.UTC(year, month, day);
    case 'weekly':
      return Date.UTC(year, month, day - date.getUTCDay());
    case 'monthly':
      return Date.UTC(year, month, 1);
    case 'yearly':
      return Date.UTC(year, 0, 1);
  }
}

/**
 * The end of the period that starts at `startMs`. A `Z` start is normalised in UTC, and hostd's
 * months and years start at midnight on the 1st.
 */
function metricPeriodEndMs(startMs: number, period: HostdMetricPeriod): number {
  const start = new Date(startMs);
  switch (period) {
    case '5m':
      return startMs + 5 * MS_PER_MINUTE;
    case '15m':
      return startMs + 15 * MS_PER_MINUTE;
    case 'hourly':
      return startMs + MS_PER_HOUR;
    case 'daily':
      return startMs + MS_PER_DAY;
    case 'weekly':
      return startMs + 7 * MS_PER_DAY;
    case 'monthly':
      return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
    case 'yearly':
      return Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate());
  }
}

interface SiaSummaryRequestConfig {
  mode: 'calendar' | 'range';
  range?: SiaSummaryRange;
  periodStart: string;
  periodEnd: string;
  previousPeriodStart?: string;
  rollingBaselineStart: string;
  dailyHistoryStart: string;
  nowIso: string;
  lastDayStart: string;
  metricPeriod: HostdMetricPeriod;
  metricStart?: string;
  periodLabel: string;
  periodShortLabel: string;
}

interface SiaNodeComputation {
  node: SiaNodeStatus;
  resolvedPeriodStart?: string;
}

interface HostdMetricEntry {
  timestamp?: string;
  storage?: {
    totalSectors?: number | string;
    physicalSectors?: number | string;
  };
  contracts?: {
    active?: number | string;
    rejected?: number | string;
    failed?: number | string;
    renewed?: number | string;
    successful?: number | string;
    lockedCollateral?: number | string;
    riskedCollateral?: number | string;
  };
  wallet?: {
    balance?: number | string;
    immatureBalance?: number | string;
  };
  revenue?: {
    potential?: Record<string, number | string>;
    earned?: Record<string, number | string>;
  };
}

@Injectable()
export class SiaService {
  private readonly logger = new Logger(SiaService.name);
  /** `host` + `walletHost` pairs whose unusable walletHost was logged, so each is logged once. */
  private readonly reportedWalletHosts = new Set<string>();

  private get sharedHosts(): string[] {
    const raw = getRuntimeEnv('SIA_HOSTS');
    if (!raw) {
      return [];
    }

    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private get sharedUsername(): string {
    return getRuntimeEnv('SIA_USERNAME') ?? '';
  }

  private get sharedPassword(): string {
    return getRuntimeEnv('SIA_PASSWORD') ?? '';
  }

  private get sharedWalletHost(): string | undefined {
    const configured = getRuntimeEnv('SIA_WALLET_HOST')?.trim();
    return configured || undefined;
  }

  private get configuredNodes(): SiaNodeConfig[] {
    const raw = getRuntimeEnv('SIA_NODES_JSON')?.trim();
    if (!raw) {
      return this.sharedHosts.map((host) => ({
        host,
        username: this.sharedUsername,
        password: this.sharedPassword,
        walletHost: this.sharedWalletHost,
      }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error('SIA_NODES_JSON is not valid JSON');
    }

    const rawNodes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { nodes?: unknown[] }).nodes)
        ? (parsed as { nodes: unknown[] }).nodes
        : null;

    if (!rawNodes) {
      throw new Error('SIA_NODES_JSON must be a JSON array or an object with a nodes array');
    }

    return rawNodes
      .map((entry): SiaNodeConfig | undefined => {
        if (typeof entry === 'string') {
          const host = entry.trim();
          return host ? { host } : undefined;
        }

        if (!entry || typeof entry !== 'object') {
          return undefined;
        }

        const record = entry as Record<string, unknown>;
        const host = String(record.host ?? '').trim();
        if (!host) {
          return undefined;
        }

        const username = String(record.username ?? '').trim();
        const password = String(record.password ?? '');
        const walletHost = String(record.walletHost ?? '').trim();

        return {
          host,
          username,
          password,
          walletHost: walletHost || undefined,
        };
      })
      .filter((entry): entry is SiaNodeConfig => Boolean(entry));
  }

  private buildAuthorizationHeader(username?: string, password?: string): string | undefined {
    return basicAuthorization(username, password);
  }

  /**
   * Every node to request: the configured ones merged with the hostd nodes found under
   * SIA_DISCOVERY_ROOTS (see mergeDiscoveredNodes). Discovery reads the disk on every call, so a
   * request resolves the list once.
   */
  private resolveNodes(): SiaNodeConfig[] {
    const roots = parseDiscoveryRoots(getRuntimeEnv('SIA_DISCOVERY_ROOTS'));
    const host = getRuntimeEnv('SIA_DISCOVERY_HOST')?.trim() || DEFAULT_DISCOVERY_HOST;
    const discovered = roots.length > 0 ? discoverSiaNodes(roots, host) : [];
    return mergeDiscoveredNodes(this.configuredNodes, discovered);
  }

  private getConfiguredNode(host: string): SiaNodeConfig {
    const normalizedHost = host.trim();
    const node = this.resolveNodes().find((entry) => entry.host === normalizedHost);
    if (!node) {
      throw new NotFoundException(`Sia host ${normalizedHost} is not configured`);
    }

    return node;
  }

  private hastingsToSiacoins(hastings?: number | string): number {
    return hastingsToSiacoins(hastings);
  }

  private getPeriodStart(): string {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    return periodStart.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private parsePeriodFromMonth(month: string): { periodStart: string; periodEnd: string } {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) {
      throw new Error(`Invalid month format: ${month}`);
    }
    const year = parseInt(match[1], 10);
    const monthIndex = parseInt(match[2], 10) - 1;
    if (monthIndex < 0 || monthIndex > 11) {
      throw new Error(`Invalid month value: ${month}`);
    }
    const start = new Date(Date.UTC(year, monthIndex, 1));
    const end = new Date(Date.UTC(year, monthIndex + 1, 1));
    return {
      periodStart: this.toIsoString(start),
      periodEnd: this.toIsoString(end),
    };
  }

  private getPreviousPeriodStart(periodStart: string): string {
    const current = new Date(periodStart);
    const previousStart = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1, 0, 0, 0),
    );
    return previousStart.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private toIsoString(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private getNowIso(): string {
    return this.toIsoString(new Date());
  }

  private getIsoHoursAgo(hours: number): string {
    return this.toIsoString(new Date(Date.now() - hours * MS_PER_HOUR));
  }

  private buildSummaryRequestConfig(options?: {
    month?: string;
    range?: SiaSummaryRange;
  }): SiaSummaryRequestConfig {
    if (options?.range) {
      const nowMs = Date.now();
      const nowIso = this.getNowIso();
      const rollingBaselineStart = this.getUtcDayStart(
        new Date(nowMs - ROLLING_WINDOW_DAYS * MS_PER_DAY),
      );
      const dailyHistoryStart = this.getUtcDayStart(
        new Date(nowMs - (ROLLING_WINDOW_DAYS + ROLLING_WINDOW_BUFFER_DAYS) * MS_PER_DAY),
      );

      switch (options.range) {
        case '1d':
          return {
            mode: 'range',
            range: options.range,
            periodStart: this.toIsoString(new Date(nowMs - MS_PER_DAY)),
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'hourly',
            metricStart: this.toIsoString(new Date(nowMs - 30 * MS_PER_HOUR)),
            periodLabel: 'Last 24 hours',
            periodShortLabel: '1D',
          };
        case '7d':
          return {
            mode: 'range',
            range: options.range,
            periodStart: this.toIsoString(new Date(nowMs - 7 * MS_PER_DAY)),
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'daily',
            metricStart: this.getUtcDayStart(new Date(nowMs - 8 * MS_PER_DAY)),
            periodLabel: 'Last 7 days',
            periodShortLabel: '7D',
          };
        case '1m':
          return {
            mode: 'range',
            range: options.range,
            periodStart: this.toIsoString(new Date(nowMs - 30 * MS_PER_DAY)),
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'daily',
            metricStart: this.getUtcDayStart(new Date(nowMs - 32 * MS_PER_DAY)),
            periodLabel: 'Last 30 days',
            periodShortLabel: '1M',
          };
        case '3m':
          return {
            mode: 'range',
            range: options.range,
            periodStart: this.toIsoString(new Date(nowMs - 90 * MS_PER_DAY)),
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'daily',
            metricStart: this.getUtcDayStart(new Date(nowMs - 95 * MS_PER_DAY)),
            periodLabel: 'Last 90 days',
            periodShortLabel: '3M',
          };
        case '1y':
          return {
            mode: 'range',
            range: options.range,
            periodStart: this.toIsoString(new Date(nowMs - 365 * MS_PER_DAY)),
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'weekly',
            metricStart: this.getUtcDayStart(new Date(nowMs - 380 * MS_PER_DAY)),
            periodLabel: 'Last 12 months',
            periodShortLabel: '1Y',
          };
        case 'all':
          return {
            mode: 'range',
            range: options.range,
            periodStart: '',
            periodEnd: nowIso,
            rollingBaselineStart,
            dailyHistoryStart,
            nowIso,
            lastDayStart: this.getIsoHoursAgo(30),
            metricPeriod: 'monthly',
            metricStart: '2015-01-01T00:00:00Z',
            periodLabel: 'All time',
            periodShortLabel: 'ALL',
          };
      }
    }

    let periodStart: string;
    let periodEnd: string;

    if (options?.month) {
      const parsed = this.parsePeriodFromMonth(options.month);
      periodStart = parsed.periodStart;
      periodEnd = parsed.periodEnd;
    } else {
      periodStart = this.getPeriodStart();
      const startDate = new Date(periodStart);
      periodEnd = this.toIsoString(
        new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1)),
      );
    }

    const periodEndMs = Date.parse(periodEnd);
    const referenceMs = options?.month ? periodEndMs : Date.now();
    // Only the month running now is "Current"; any other ?month= is named, e.g. "September 2026".
    const isCurrentMonth = periodStart === this.getPeriodStart();

    return {
      mode: 'calendar',
      periodStart,
      periodEnd,
      previousPeriodStart: this.getPreviousPeriodStart(periodStart),
      rollingBaselineStart: this.getUtcDayStart(
        new Date(referenceMs - ROLLING_WINDOW_DAYS * MS_PER_DAY),
      ),
      dailyHistoryStart: this.getUtcDayStart(
        new Date(referenceMs - (ROLLING_WINDOW_DAYS + ROLLING_WINDOW_BUFFER_DAYS) * MS_PER_DAY),
      ),
      nowIso: options?.month ? periodEnd : this.getNowIso(),
      lastDayStart: options?.month
        ? this.toIsoString(new Date(periodEndMs - 30 * MS_PER_HOUR))
        : this.getIsoHoursAgo(30),
      metricPeriod: 'monthly',
      metricStart: this.getPreviousPeriodStart(periodStart),
      periodLabel: isCurrentMonth ? 'Current month' : this.formatUtcMonth(periodStart, 'long'),
      periodShortLabel: isCurrentMonth ? 'Current' : this.formatUtcMonth(periodStart, 'short'),
    };
  }

  /** `September 2026` (long) or `Sep 2026` (short) for the UTC month of an ISO timestamp. */
  private formatUtcMonth(iso: string, month: 'long' | 'short'): string {
    return new Date(iso).toLocaleString('en-US', { month, year: 'numeric', timeZone: 'UTC' });
  }

  private getLatestMetricEntry(entries?: HostdMetricEntry[]): HostdMetricEntry | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length === 0) {
      return undefined;
    }

    return ordered[ordered.length - 1];
  }

  private getEarliestMetricTimestamp(entries?: HostdMetricEntry[]): string | undefined {
    const ordered = this.orderMetricEntries(entries);
    return ordered?.[0]?.timestamp;
  }

  /** The last entry of `period` with totals as of `targetIso` or earlier (see metricEntryAsOfMs). */
  private pickMetricBaselineEntry(
    entries: HostdMetricEntry[] | undefined,
    period: HostdMetricPeriod,
    targetIso: string,
    nowMs: number,
  ): HostdMetricEntry | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length === 0) {
      return undefined;
    }

    const targetMs = Date.parse(targetIso);
    if (!Number.isFinite(targetMs)) {
      return undefined;
    }

    let baseline: HostdMetricEntry | undefined;
    for (const entry of ordered) {
      if (!entry.timestamp) {
        continue;
      }
      const timestamp = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      if (metricEntryAsOfMs(timestamp, period, nowMs) <= targetMs) {
        baseline = entry;
      } else {
        break;
      }
    }

    return baseline;
  }

  /**
   * The calendar month's revenue while a range is shown, from the first of `series` with totals as
   * of the month's first midnight exactly: the daily entry of the previous month's last day or the
   * previous month's monthly entry (a weekly entry ends there only when the 1st is a Sunday). When
   * none has them, from the last totals before that midnight (weekly totals alone: up to six days
   * more); when none reaches back that far, from the earliest totals of the first series that has
   * two entries and was requested from the month's start or earlier: its history begins within the
   * month. Undefined when no series tells (the daily and monthly requests failed, and the range's
   * own series, such as 1d's last 30 hours, begins within the month): those totals would read as
   * the month's revenue. Each series is [period, entries, the start it was requested from].
   */
  private currentMonthInRange(
    series: Array<[HostdMetricPeriod, HostdMetricEntry[] | undefined, string]>,
    calendarBaselineStart: string,
    nowMs: number,
  ): SiaMetricSnapshot | undefined {
    for (const match of MONTH_BASELINES) {
      for (const [period, entries, requestedFrom] of series) {
        const snapshot = this.buildCurrentMonthMetricSnapshot(
          entries,
          period,
          requestedFrom,
          calendarBaselineStart,
          nowMs,
          match,
        );
        if (snapshot) {
          return snapshot;
        }
      }
    }
    return undefined;
  }

  /** The revenue since `calendarBaselineStart` in one series, from the baseline `match` allows. */
  private buildCurrentMonthMetricSnapshot(
    entries: HostdMetricEntry[] | undefined,
    period: HostdMetricPeriod,
    requestedFrom: string,
    calendarBaselineStart: string,
    nowMs: number,
    match: MonthBaseline,
  ): SiaMetricSnapshot | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length < 2) {
      return undefined;
    }

    const currentEntry = ordered[ordered.length - 1];
    const lastBeforeMonth = this.pickMetricBaselineEntry(
      ordered,
      period,
      calendarBaselineStart,
      nowMs,
    );
    let baselineEntry: HostdMetricEntry | undefined;
    switch (match) {
      case 'atMonthStart': {
        const timestampMs = Date.parse(lastBeforeMonth?.timestamp ?? '');
        const atMonthStart =
          Number.isFinite(timestampMs) &&
          metricEntryAsOfMs(timestampMs, period, nowMs) === Date.parse(calendarBaselineStart);
        baselineEntry = atMonthStart ? lastBeforeMonth : undefined;
        break;
      }
      case 'beforeMonthStart':
        baselineEntry = lastBeforeMonth;
        break;
      case 'earliest':
        baselineEntry =
          lastBeforeMonth ??
          (Date.parse(requestedFrom) <= Date.parse(calendarBaselineStart) ? ordered[0] : undefined);
        break;
    }

    if (!baselineEntry || baselineEntry === currentEntry) {
      return undefined;
    }

    const baselineMs = Date.parse(baselineEntry.timestamp ?? '');
    const currentMs = Date.parse(currentEntry.timestamp ?? '');
    if (!Number.isFinite(baselineMs) || !Number.isFinite(currentMs) || baselineMs >= currentMs) {
      return undefined;
    }

    return this.buildMetricRowsFromSnapshots(currentEntry, baselineEntry).totals.current;
  }

  private buildMetricRowsFromSnapshots(
    currentEntry: HostdMetricEntry | undefined,
    baselineEntry: HostdMetricEntry | undefined,
  ): {
    metrics: SiaMetricRow[];
    totals: {
      current: { potential: number; earned: number };
      total: { potential: number; earned: number };
    };
  } {
    const metricKeys = new Set(
      Object.keys(currentEntry?.revenue?.potential ?? {})
        .concat(Object.keys(baselineEntry?.revenue?.potential ?? {}))
        .concat(Object.keys(currentEntry?.revenue?.earned ?? {}))
        .concat(Object.keys(baselineEntry?.revenue?.earned ?? {})),
    );
    metricKeys.delete('registryRead');
    metricKeys.delete('registryWrite');

    const metrics = Array.from(metricKeys).map((metric) =>
      this.buildMetricRow(metric, currentEntry?.revenue, baselineEntry?.revenue),
    );

    const totals = metrics.reduce(
      (accumulator, current) => {
        if (!RELEVANT_METRICS.has(current.metric)) {
          return accumulator;
        }

        return {
          current: {
            potential: accumulator.current.potential + current.current.potential,
            earned: accumulator.current.earned + current.current.earned,
          },
          total: {
            potential: accumulator.total.potential + current.total.potential,
            earned: accumulator.total.earned + current.total.earned,
          },
        };
      },
      {
        current: { potential: 0, earned: 0 },
        total: { potential: 0, earned: 0 },
      },
    );

    return { metrics, totals };
  }

  private parseCount(value?: number | string): number {
    if (value === undefined || value === null) {
      return 0;
    }

    const numeric = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(numeric)) {
      return 0;
    }

    return Math.max(Math.trunc(numeric), 0);
  }

  private buildContractSummaryFromSnapshots(
    currentEntry: HostdMetricEntry | undefined,
    baselineEntry: HostdMetricEntry | undefined,
  ): SiaContractSummary | undefined {
    const currentContracts = currentEntry?.contracts;
    const previousContracts = baselineEntry?.contracts;

    if (!currentContracts && !previousContracts) {
      return undefined;
    }

    const buildStat = (
      currentValue?: number | string,
      previousValue?: number | string,
    ): SiaContractSummary[keyof SiaContractSummary] => {
      const currentCount = this.parseCount(currentValue);
      const previousCount = this.parseCount(previousValue);
      return {
        currentCount,
        deltaCount: currentCount - previousCount,
      };
    };

    return {
      active: buildStat(currentContracts?.active, previousContracts?.active),
      successful: buildStat(currentContracts?.successful, previousContracts?.successful),
      renewed: buildStat(currentContracts?.renewed, previousContracts?.renewed),
      failed: buildStat(currentContracts?.failed, previousContracts?.failed),
    };
  }

  async announceHost(host: string): Promise<{ host: string; success: true }> {
    const node = this.getConfiguredNode(host);
    const authorization = this.buildAuthorizationHeader(node.username, node.password);
    await requestNodeText(`${nodeBaseUrl(node.host)}/api/settings/announce`, {
      method: 'POST',
      authorization,
    });

    return {
      host: node.host,
      success: true,
    };
  }

  private getUtcDayStart(date: Date): string {
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0),
    );
    return this.toIsoString(start);
  }

  private extractMetricValue(
    source: Record<string, number | string> | undefined,
    metric: string,
  ): number {
    const raw = source?.[metric];
    if (raw === undefined || raw === null) {
      return 0;
    }

    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    return this.hastingsToSiacoins(numeric);
  }

  private buildMetricRow(
    metric: string,
    currentRevenue: { potential?: Record<string, any>; earned?: Record<string, any> } | undefined,
    previousRevenue: { potential?: Record<string, any>; earned?: Record<string, any> } | undefined,
  ): SiaMetricRow {
    const totalPotential = this.extractMetricValue(currentRevenue?.potential, metric);
    const totalEarned = this.extractMetricValue(currentRevenue?.earned, metric);

    const previousPotential = this.extractMetricValue(previousRevenue?.potential, metric);
    const previousEarned = this.extractMetricValue(previousRevenue?.earned, metric);

    const currentPotential = Math.max(totalPotential - previousPotential, 0);
    const currentEarned = Math.max(totalEarned - previousEarned, 0);

    return {
      metric,
      current: {
        potential: currentPotential,
        earned: currentEarned,
      },
      total: {
        potential: totalPotential,
        earned: totalEarned,
      },
    };
  }

  private async fetchStorageUsage(host: string, authorization?: string): Promise<SiaStorageUsage> {
    const payload = await getNodeObject(`${nodeBaseUrl(host)}/api/metrics`, { authorization });
    const storage = payload.storage;
    if (!storage || typeof storage !== 'object') {
      // Not a hostd metrics reply: use the historical snapshot instead of a 0-byte disk.
      invalidResponse('Storage metrics payload is incomplete');
    }

    const totalSectors = Math.max(toNumberOrUndefined(storage.totalSectors) ?? 0, 0);
    const usedSectors = Math.max(toNumberOrUndefined(storage.physicalSectors) ?? 0, 0);

    const capacityBytes = totalSectors * SECTOR_SIZE_BYTES;
    const usedBytes = Math.min(usedSectors, totalSectors) * SECTOR_SIZE_BYTES;
    const freeBytes = Math.max(capacityBytes - usedBytes, 0);

    return {
      usedBytes,
      capacityBytes,
      freeBytes,
    };
  }

  private async fetchHostdMetrics(
    host: string,
    period: HostdMetricPeriod,
    start?: string,
    end?: string,
    authorization?: string,
  ): Promise<HostdMetricEntry[]> {
    const baseOverride = getRuntimeEnv('SIA_METRICS_BASE_URL')?.trim();
    const baseUrl = baseOverride
      ? baseOverride.endsWith('/')
        ? baseOverride
        : `${baseOverride}/`
      : `${nodeBaseUrl(host)}/api/`;

    let url: URL;
    try {
      url = new URL(`metrics/${period}`, baseUrl);
    } catch (error) {
      // Only a malformed SIA_METRICS_BASE_URL gets here: a node's base URL always parses.
      throw new NodeRequestError('invalid_endpoint', 'Invalid SIA_METRICS_BASE_URL', {
        cause: error,
      });
    }
    if (baseOverride && url.hostname.includes('api.sia.tech')) {
      url.searchParams.set('host', host);
    }
    if (start) {
      url.searchParams.set('start', start);
    }
    if (end) {
      url.searchParams.set('end', end);
    }
    // hostd reads `start` and `periods`, not `end`. A month view ends on the next 1st, which for
    // the running month is still ahead: periods that have not begun yet are not asked for.
    const startMs = Date.parse(start ?? '');
    const endMs = Math.min(Date.parse(end ?? ''), Date.now());
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      url.searchParams.set('periods', String(metricPeriodCount(startMs, endMs, period)));
    }

    return (await getNodeArray(url.toString(), { authorization })) as HostdMetricEntry[];
  }

  private sectorsToBytes(value?: number | string): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return numeric * SECTOR_SIZE_BYTES;
  }

  private orderMetricEntries(entries?: HostdMetricEntry[]): HostdMetricEntry[] | undefined {
    if (!entries || entries.length === 0) {
      return undefined;
    }

    const ordered = entries
      .map((entry) => ({
        entry,
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN,
      }))
      .filter((item) => Number.isFinite(item.timestamp))
      .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
      .map((item) => item.entry);

    return ordered.length > 0 ? ordered : undefined;
  }

  private buildStorageSnapshotFromEntries(
    entries?: HostdMetricEntry[],
  ): SiaStorageUsage | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length === 0) {
      return undefined;
    }

    const latest = ordered[ordered.length - 1];
    const capacityBytes = this.sectorsToBytes(latest.storage?.totalSectors);
    const usedBytes = this.sectorsToBytes(latest.storage?.physicalSectors);

    if (capacityBytes === undefined || usedBytes === undefined) {
      return undefined;
    }

    const safeCapacity = Math.max(capacityBytes, 0);
    const safeUsed = Math.min(Math.max(usedBytes, 0), safeCapacity);
    const freeBytes = Math.max(safeCapacity - safeUsed, 0);

    return {
      usedBytes: safeUsed,
      capacityBytes: safeCapacity,
      freeBytes,
    };
  }

  private extractLockedCollateral(entries?: HostdMetricEntry[]): number | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length === 0) {
      return undefined;
    }

    const latest = ordered[ordered.length - 1];
    const raw = latest.contracts?.lockedCollateral;
    if (raw === undefined || raw === null) {
      return undefined;
    }

    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return this.hastingsToSiacoins(numeric);
  }

  private extractWalletBalance(entries?: HostdMetricEntry[]): number | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length === 0) {
      return undefined;
    }

    const latest = ordered[ordered.length - 1];
    const raw = latest.wallet?.balance;
    if (raw === undefined || raw === null) {
      return undefined;
    }

    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return this.hastingsToSiacoins(numeric);
  }

  /**
   * The stored bytes of `entries` of `period` at the times they were current (see
   * metricEntryAsOfMs), oldest first.
   */
  private storagePoints(
    entries: HostdMetricEntry[] | undefined,
    period: HostdMetricPeriod,
    nowMs: number,
  ): StoragePoint[] {
    return (entries ?? [])
      .map((entry) => {
        const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
        return {
          asOfMs: Number.isFinite(timestamp)
            ? metricEntryAsOfMs(timestamp, period, nowMs)
            : Number.NaN,
          usedBytes: this.sectorsToBytes(entry.storage?.physicalSectors),
        };
      })
      .filter(
        (point): point is StoragePoint =>
          Number.isFinite(point.asOfMs) &&
          typeof point.usedBytes === 'number' &&
          Number.isFinite(point.usedBytes),
      )
      .sort((a, b) => a.asOfMs - b.asOfMs);
  }

  /**
   * The stored bytes at `target`, interpolated between the points around it, and the time they are
   * for (`target`, or the one point there); undefined when the points do not reach both sides.
   */
  private interpolatedBaseline(
    points: StoragePoint[],
    target: number,
  ): { baselineBytes: number; baselineMs: number } | undefined {
    let lower: StoragePoint | undefined;
    let upper: StoragePoint | undefined;
    for (const point of points) {
      if (point.asOfMs <= target) {
        lower = point;
      }
      if (point.asOfMs >= target && !upper) {
        upper = point;
      }
    }

    if (!lower || !upper) {
      return undefined;
    }
    if (upper.asOfMs === lower.asOfMs) {
      return { baselineBytes: lower.usedBytes, baselineMs: lower.asOfMs };
    }

    const ratio = (target - lower.asOfMs) / (upper.asOfMs - lower.asOfMs);
    return {
      baselineBytes:
        lower.usedBytes + (upper.usedBytes - lower.usedBytes) * Math.max(Math.min(ratio, 1), 0),
      baselineMs: target,
    };
  }

  private computeStorageDelta(
    points: StoragePoint[],
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (points.length < 2) {
      return undefined;
    }

    const previous = points[points.length - 2];
    const latest = points[points.length - 1];
    const deltaBytes = latest.usedBytes - previous.usedBytes;
    const hoursRaw = (latest.asOfMs - previous.asOfMs) / MS_PER_HOUR;
    const sampleHours =
      Number.isFinite(hoursRaw) && hoursRaw > 0
        ? Math.max(Number(hoursRaw.toFixed(1)), 0)
        : undefined;

    return {
      deltaBytes,
      sampleHours,
    };
  }

  /** The change over the `windowMs` before `nowMs`, from the live total `currentUsedBytes`. */
  private computeLiveDelta(
    currentUsedBytes: number,
    points: StoragePoint[],
    windowMs: number,
    nowMs: number,
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (points.length === 0 || !Number.isFinite(currentUsedBytes)) {
      return undefined;
    }

    const baseline = this.interpolatedBaseline(points, nowMs - windowMs);
    if (!baseline) {
      return undefined;
    }

    const deltaBytes = currentUsedBytes - baseline.baselineBytes;
    const sampleHours = Math.max(
      Number(((nowMs - baseline.baselineMs) / MS_PER_HOUR).toFixed(1)),
      0,
    );

    return {
      deltaBytes,
      sampleHours,
    };
  }

  /** The change over the `windowMs` before the newest point, from the newest point's total. */
  private computeWindowDelta(
    points: StoragePoint[],
    windowMs: number,
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (points.length < 2) {
      return undefined;
    }

    const latest = points[points.length - 1];
    const baseline = this.interpolatedBaseline(points, latest.asOfMs - windowMs);
    if (!baseline) {
      return undefined;
    }

    const deltaBytes = latest.usedBytes - baseline.baselineBytes;
    const sampleHours = Math.max(
      Number(((latest.asOfMs - baseline.baselineMs) / MS_PER_HOUR).toFixed(1)),
      0,
    );

    return {
      deltaBytes,
      sampleHours,
    };
  }

  /** The stored bytes at `baselineStartMs`: from the first daily entry with totals as of then or later. */
  private pickBaselineFromDaily(
    entries: HostdMetricEntry[] | undefined,
    baselineStartMs: number,
    nowMs: number,
  ): number | undefined {
    if (!entries || entries.length === 0 || !Number.isFinite(baselineStartMs)) {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.timestamp) {
        continue;
      }
      const timestamp = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      if (metricEntryAsOfMs(timestamp, 'daily', nowMs) >= baselineStartMs) {
        const bytes = this.sectorsToBytes(entry.storage?.physicalSectors);
        if (typeof bytes === 'number' && Number.isFinite(bytes)) {
          return bytes;
        }
      }
    }

    const fallback = this.sectorsToBytes(entries[0].storage?.physicalSectors);
    return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : undefined;
  }

  private extractPeriodStartBytes(
    entries: HostdMetricEntry[] | undefined,
    periodStart: string,
  ): number | undefined {
    if (!entries || entries.length === 0) {
      return undefined;
    }

    const periodStartMs = Date.parse(periodStart);
    if (!Number.isFinite(periodStartMs)) {
      return undefined;
    }

    const ordered = this.orderMetricEntries(entries);
    if (!ordered) {
      return undefined;
    }

    const match = ordered.find((entry) => {
      if (!entry.timestamp) {
        return false;
      }
      const timestamp = Date.parse(entry.timestamp);
      return Number.isFinite(timestamp) && timestamp === (periodStartMs as number);
    });

    if (!match) {
      return undefined;
    }

    return this.sectorsToBytes(match.storage?.physicalSectors);
  }

  private resolveStorageBaselineBytes(params: {
    orderedDailyEntries?: HostdMetricEntry[];
    baselineStart: string;
    nowMs: number;
  }): number | undefined {
    const orderedDailyEntries = params.orderedDailyEntries;
    const baselineMs = Date.parse(params.baselineStart);

    const dailyBaseline = this.pickBaselineFromDaily(orderedDailyEntries, baselineMs, params.nowMs);
    if (dailyBaseline !== undefined) {
      return dailyBaseline;
    }

    return undefined;
  }

  private enrichStorageUsage(
    usage: SiaStorageUsage,
    options: {
      dailyEntries?: HostdMetricEntry[];
      dayDeltaEntries?: HostdMetricEntry[];
      rollingBaselineStart: string;
      calendarBaselineStart: string;
      rangeWindowMs?: number;
      rangeLabel?: string;
      metricEntries?: HostdMetricEntry[];
      metricPeriod: HostdMetricPeriod;
      nowMs: number;
    },
  ): SiaStorageUsage {
    const enriched: SiaStorageUsage = { ...usage };
    const nowMs = options.nowMs;

    const orderedDailyEntries = this.orderMetricEntries(options.dailyEntries);
    const orderedMetricEntries = this.orderMetricEntries(options.metricEntries);
    // Each series' storage totals at the times they were current (see metricEntryAsOfMs).
    const quarterHourPoints = this.storagePoints(options.dayDeltaEntries, '15m', nowMs);
    const dailyPoints = this.storagePoints(orderedDailyEntries, 'daily', nowMs);
    const metricPoints = this.storagePoints(orderedMetricEntries, options.metricPeriod, nowMs);

    const dailyDelta =
      this.computeWindowDelta(quarterHourPoints, MS_PER_DAY) ??
      this.computeLiveDelta(usage.usedBytes, quarterHourPoints, MS_PER_DAY, nowMs) ??
      this.computeLiveDelta(usage.usedBytes, dailyPoints, MS_PER_DAY, nowMs) ??
      this.computeStorageDelta(this.storagePoints(orderedDailyEntries?.slice(-2), 'daily', nowMs));
    if (dailyDelta) {
      enriched.changeDayBytes = dailyDelta.deltaBytes;
      enriched.changeDaySampleHours = dailyDelta.sampleHours;
    }

    const monthDelta = this.computeWindowDelta(dailyPoints, ROLLING_WINDOW_DAYS * MS_PER_DAY);

    if (monthDelta) {
      enriched.changeMonthBytes = monthDelta.deltaBytes;
    } else {
      const baselineBytes = this.resolveStorageBaselineBytes({
        orderedDailyEntries,
        baselineStart: options.rollingBaselineStart,
        nowMs,
      });

      if (baselineBytes !== undefined) {
        enriched.changeMonthBytes = usage.usedBytes - baselineBytes;
      }
    }

    const calendarBaselineBytes = this.resolveStorageBaselineBytes({
      orderedDailyEntries,
      baselineStart: options.calendarBaselineStart,
      nowMs,
    });

    if (calendarBaselineBytes !== undefined) {
      enriched.changeMonthCalendarBytes = usage.usedBytes - calendarBaselineBytes;
    }

    if (enriched.changeMonthBytes !== undefined) {
      enriched.changeMonthBaselineStart = options.rollingBaselineStart;
    }

    if (options.rangeWindowMs !== undefined && options.rangeWindowMs > 0) {
      const rangeWindowMs = options.rangeWindowMs;
      // From the finest series that covers the window.
      const finestFirst = [quarterHourPoints, dailyPoints, metricPoints];
      const rangeDelta =
        finestFirst.map((points) => this.computeWindowDelta(points, rangeWindowMs)).find(Boolean) ??
        finestFirst
          .map((points) => this.computeLiveDelta(usage.usedBytes, points, rangeWindowMs, nowMs))
          .find(Boolean);
      if (rangeDelta) {
        enriched.changeRangeBytes = rangeDelta.deltaBytes;
        enriched.changeRangeSampleHours = rangeDelta.sampleHours;
      }
    } else if (options.rangeLabel === 'ALL' && orderedMetricEntries && orderedMetricEntries.length > 0) {
      const first = orderedMetricEntries[0];
      const baselineBytes = this.sectorsToBytes(first.storage?.physicalSectors);
      if (typeof baselineBytes === 'number' && Number.isFinite(baselineBytes)) {
        enriched.changeRangeBytes = usage.usedBytes - baselineBytes;
      }
    }

    if (options.rangeLabel) {
      enriched.changeRangeLabel = options.rangeLabel;
    }

    return enriched;
  }

  private getRangeWindowMs(config: SiaSummaryRequestConfig): number | undefined {
    if (config.mode !== 'range' || !config.range) {
      return undefined;
    }
    switch (config.range) {
      case '1d':
        return MS_PER_DAY;
      case '7d':
        return 7 * MS_PER_DAY;
      case '1m':
        return 30 * MS_PER_DAY;
      case '3m':
        return 90 * MS_PER_DAY;
      case '1y':
        return 365 * MS_PER_DAY;
      case 'all':
      default:
        return undefined;
    }
  }

  /**
   * hostd `GET /api/wallet`: `{"spendable","confirmed","unconfirmed","immature"}` in hastings (older
   * hostd has no `immature`). A reply without the three balances is not a hostd wallet, so it
   * fails here and the next source is used instead of an all-zero wallet.
   */
  private async fetchHostdWallet(host: string, authorization?: string): Promise<SiaWalletSummary> {
    const payload = await getNodeObject(`${nodeBaseUrl(host)}/api/wallet`, { authorization });
    const confirmed = hastingsToSiacoinsOrUndefined(payload.confirmed);
    const spendable = hastingsToSiacoinsOrUndefined(payload.spendable);
    const unconfirmed = hastingsToSiacoinsOrUndefined(payload.unconfirmed);
    if (confirmed === undefined || spendable === undefined || unconfirmed === undefined) {
      invalidResponse('Wallet payload is incomplete');
    }

    return {
      confirmed,
      spendable,
      unconfirmedIncoming: unconfirmed,
      unconfirmedOutgoing: Math.max(confirmed - spendable, 0),
      immature: hastingsToSiacoinsOrUndefined(payload.immature),
    };
  }

  /**
   * A separately configured wallet service (`walletHost`) at `GET /wallet` with
   * `confirmedSiacoinBalance`-style keys. Missing balances fail instead of reading as 0 SC.
   */
  private async fetchWalletHostSummary(
    walletHost: string,
    authorization?: string,
  ): Promise<SiaWalletSummary> {
    const payload = await getNodeObject(`${nodeBaseUrl(walletHost)}/wallet`, { authorization });
    const confirmed = hastingsToSiacoinsOrUndefined(payload.confirmedSiacoinBalance);
    const spendable = hastingsToSiacoinsOrUndefined(payload.spendableSiacoinBalance);
    if (confirmed === undefined || spendable === undefined) {
      invalidResponse('Wallet payload is incomplete');
    }

    return {
      confirmed,
      spendable,
      unconfirmedIncoming: hastingsToSiacoins(payload.unconfirmedIncomingSiacoinBalance),
      unconfirmedOutgoing: hastingsToSiacoins(payload.unconfirmedOutgoingSiacoinBalance),
    };
  }

  /**
   * The configured wallet service first (when set), then hostd's own wallet API. A walletHost that
   * cannot be requested (an address that does not parse) is skipped like an unreachable one, but
   * logged once as a config mistake, since the node itself still shows as OK.
   */
  private async fetchWalletSummary(
    nodeConfig: SiaNodeConfig,
    authorization?: string,
  ): Promise<SiaWalletSummary | undefined> {
    if (nodeConfig.walletHost) {
      try {
        return await this.fetchWalletHostSummary(nodeConfig.walletHost, authorization);
      } catch (error) {
        if (error instanceof NodeRequestError && error.kind === 'invalid_endpoint') {
          this.reportUnusableWalletHost(nodeConfig, error.message);
        }
        // Fall through to hostd's wallet.
      }
    }
    try {
      return await this.fetchHostdWallet(nodeConfig.host, authorization);
    } catch {
      return undefined;
    }
  }

  /** The message is fixed text of the request layer; the walletHost value is never logged. */
  private reportUnusableWalletHost(nodeConfig: SiaNodeConfig, message: string): void {
    const key = `${nodeConfig.host}\n${nodeConfig.walletHost}`;
    if (this.reportedWalletHosts.has(key)) {
      return;
    }
    this.reportedWalletHosts.add(key);
    this.logger.warn(
      `walletHost of Sia node ${displayNodeHost(nodeConfig.host)} is not used: ${message}. ` +
        "The wallet shown is hostd's.",
    );
  }

  async fetchSummary(options?: { month?: string; range?: SiaSummaryRange }): Promise<SiaSummary> {
    if (process.env.DEMO_MODE === 'true') {
      return this.getMockSiaSummary(options);
    }

    const config = this.buildSummaryRequestConfig(options);
    const calendarBaselineStart =
      config.mode === 'calendar' ? config.periodStart : this.getPeriodStart();

    const nodeResults = await Promise.all(
      this.resolveNodes().map(async (nodeConfig): Promise<SiaNodeComputation> => {
        const host = nodeConfig.host;
        const authorization = this.buildAuthorizationHeader(
          nodeConfig.username,
          nodeConfig.password,
        );
        let baseUrl: string | undefined;

        try {
          baseUrl = nodeBaseUrl(host);
          const metricEntriesPromise = this.fetchHostdMetrics(
            host,
            config.metricPeriod,
            config.metricStart,
            config.nowIso,
            authorization,
          );
          const dailyEntriesPromise = this.fetchHostdMetrics(
            host,
            'daily',
            config.dailyHistoryStart,
            config.nowIso,
            authorization,
          ).catch(() => undefined);
          const dayDeltaEntriesPromise = this.fetchHostdMetrics(
            host,
            '15m',
            config.lastDayStart,
            config.nowIso,
            authorization,
          ).catch(() => undefined);
          const currentMonthMetricEntriesPromise =
            config.mode === 'range'
              ? this.fetchHostdMetrics(
                  host,
                  'monthly',
                  this.getPreviousPeriodStart(calendarBaselineStart),
                  config.nowIso,
                  authorization,
                ).catch(() => undefined)
              : Promise.resolve(undefined);
          const liveStorageSnapshotPromise = this.fetchStorageUsage(host, authorization).catch(
            () => undefined,
          );

          const [
            metricEntries,
            dailyEntries,
            dayDeltaEntries,
            currentMonthMetricEntries,
            liveStorageSnapshot,
          ] =
            await Promise.all([
              metricEntriesPromise,
              dailyEntriesPromise,
              dayDeltaEntriesPromise,
              currentMonthMetricEntriesPromise,
              liveStorageSnapshotPromise,
            ]);

          // The entries of the periods still running hold the totals as of now (metricEntryAsOfMs).
          const nowMs = Date.now();
          const orderedMetricEntries = this.orderMetricEntries(metricEntries);
          if (!orderedMetricEntries || orderedMetricEntries.length === 0) {
            invalidResponse(`${config.metricPeriod} metrics payload is incomplete`);
          }

          const currentEntry = orderedMetricEntries[orderedMetricEntries.length - 1];
          let baselineEntry: HostdMetricEntry | undefined;
          let resolvedPeriodStart = config.periodStart;

          if (config.mode === 'calendar') {
            if (orderedMetricEntries.length < 2) {
              invalidResponse('Monthly metrics payload is incomplete');
            }
            baselineEntry = orderedMetricEntries[orderedMetricEntries.length - 2];
          } else if (config.range === 'all') {
            resolvedPeriodStart = this.getEarliestMetricTimestamp(orderedMetricEntries) ?? '';
          } else {
            // The last entry with totals as of the period start or earlier, so a range covers at
            // least its length and at most one period more.
            baselineEntry = this.pickMetricBaselineEntry(
              orderedMetricEntries,
              config.metricPeriod,
              config.periodStart,
              nowMs,
            );
          }

          const { metrics, totals } = this.buildMetricRowsFromSnapshots(currentEntry, baselineEntry);
          let currentMonthSnapshot: SiaMetricSnapshot | undefined = totals.current;
          if (config.mode === 'range') {
            currentMonthSnapshot = this.currentMonthInRange(
              [
                ['daily', dailyEntries, config.dailyHistoryStart],
                [config.metricPeriod, orderedMetricEntries, config.metricStart ?? ''],
                [
                  'monthly',
                  currentMonthMetricEntries,
                  this.getPreviousPeriodStart(calendarBaselineStart),
                ],
              ],
              calendarBaselineStart,
              nowMs,
            );
          }
          const contractBaselineEntry =
            baselineEntry ??
            (config.range === 'all' ? orderedMetricEntries[0] : undefined) ??
            orderedMetricEntries[0];
          const contracts = this.buildContractSummaryFromSnapshots(
            currentEntry,
            contractBaselineEntry,
          );

          const historicalStorageSnapshot =
            this.buildStorageSnapshotFromEntries(dayDeltaEntries) ??
            this.buildStorageSnapshotFromEntries(dailyEntries) ??
            this.buildStorageSnapshotFromEntries(orderedMetricEntries);

          const resolvedStorageSnapshot = liveStorageSnapshot ?? historicalStorageSnapshot;

          let storage: SiaStorageUsage | undefined;
          if (resolvedStorageSnapshot) {
            try {
              storage = this.enrichStorageUsage(resolvedStorageSnapshot, {
                dailyEntries,
                dayDeltaEntries,
                rollingBaselineStart: config.rollingBaselineStart,
                calendarBaselineStart,
                rangeWindowMs: this.getRangeWindowMs(config),
                rangeLabel: config.mode === 'range' ? config.periodShortLabel : undefined,
                metricEntries: orderedMetricEntries,
                metricPeriod: config.metricPeriod,
                nowMs,
              });
            } catch {
              storage = undefined;
            }
          }

          let wallet: SiaWalletSummary | undefined;
          const lockedCollateral =
            this.extractLockedCollateral(dayDeltaEntries) ??
            this.extractLockedCollateral(dailyEntries) ??
            this.extractLockedCollateral(orderedMetricEntries);
          const metricsWalletBalance =
            this.extractWalletBalance(dayDeltaEntries) ??
            this.extractWalletBalance(dailyEntries) ??
            this.extractWalletBalance(orderedMetricEntries);
          wallet = await this.fetchWalletSummary(nodeConfig, authorization);
          if (wallet && lockedCollateral !== undefined) {
            wallet.lockedCollateral = lockedCollateral;
          }

          if (!wallet && metricsWalletBalance !== undefined) {
            wallet = {
              confirmed: metricsWalletBalance,
              spendable: metricsWalletBalance,
              unconfirmedIncoming: 0,
              unconfirmedOutgoing: 0,
              lockedCollateral,
            };
          }

          return {
            node: {
              host: displayNodeHost(host),
              baseUrl,
              status: 'ok',
              metrics,
              totals: {
                ...totals,
                currentMonth: currentMonthSnapshot,
              },
              storage,
              wallet,
              contracts,
            },
            resolvedPeriodStart,
          };
        } catch (error) {
          return {
            node: {
              host: displayNodeHost(host),
              baseUrl,
              status: 'error',
              ...toNodeFailure(error),
            },
          };
        }
      }),
    );

    const nodes = nodeResults.map((result) => result.node);
    const resolvedPeriodStart =
      config.mode === 'range' && config.range === 'all'
        ? nodeResults
            .map((result) => result.resolvedPeriodStart)
            .filter((value): value is string => Boolean(value))
            .sort()[0] ?? ''
        : config.periodStart;

    const aggregate = nodes.reduce<SiaSummary['aggregate']>(
      (accumulator, current) => {
        if (current.status === 'ok') {
          const addOptional = (a?: number, b?: number): number | undefined => {
            const aNum = typeof a === 'number' && Number.isFinite(a) ? a : undefined;
            const bNum = typeof b === 'number' && Number.isFinite(b) ? b : undefined;
            if (aNum === undefined && bNum === undefined) {
              return undefined;
            }
            return (aNum ?? 0) + (bNum ?? 0);
          };

          const mergeSample = (a?: number, b?: number): number | undefined => {
            const aNum = typeof a === 'number' && Number.isFinite(a) ? a : undefined;
            const bNum = typeof b === 'number' && Number.isFinite(b) ? b : undefined;
            if (aNum === undefined) {
              return bNum;
            }
            if (bNum === undefined) {
              return aNum;
            }
            return Math.min(aNum, bNum);
          };

          const mergeContracts = (
            existing?: SiaContractSummary,
            next?: SiaContractSummary,
          ): SiaContractSummary | undefined => {
            if (!existing && !next) {
              return undefined;
            }

            return {
              active: {
                currentCount:
                  (existing?.active.currentCount ?? 0) + (next?.active.currentCount ?? 0),
                deltaCount: (existing?.active.deltaCount ?? 0) + (next?.active.deltaCount ?? 0),
              },
              successful: {
                currentCount:
                  (existing?.successful.currentCount ?? 0) +
                  (next?.successful.currentCount ?? 0),
                deltaCount:
                  (existing?.successful.deltaCount ?? 0) + (next?.successful.deltaCount ?? 0),
              },
              renewed: {
                currentCount:
                  (existing?.renewed.currentCount ?? 0) + (next?.renewed.currentCount ?? 0),
                deltaCount:
                  (existing?.renewed.deltaCount ?? 0) + (next?.renewed.deltaCount ?? 0),
              },
              failed: {
                currentCount:
                  (existing?.failed.currentCount ?? 0) + (next?.failed.currentCount ?? 0),
                deltaCount: (existing?.failed.deltaCount ?? 0) + (next?.failed.deltaCount ?? 0),
              },
            };
          };

          return {
            current: {
              potential: accumulator.current.potential + current.totals.current.potential,
              earned: accumulator.current.earned + current.totals.current.earned,
            },
            total: {
              potential: accumulator.total.potential + current.totals.total.potential,
              earned: accumulator.total.earned + current.totals.total.earned,
            },
            currentMonth: {
              potential:
                (accumulator.currentMonth?.potential ?? 0) +
                (current.totals.currentMonth?.potential ?? 0),
              earned:
                (accumulator.currentMonth?.earned ?? 0) +
                (current.totals.currentMonth?.earned ?? 0),
            },
            storage: {
              usedBytes: accumulator.storage.usedBytes + (current.storage?.usedBytes ?? 0),
              capacityBytes:
                accumulator.storage.capacityBytes + (current.storage?.capacityBytes ?? 0),
              freeBytes: accumulator.storage.freeBytes + (current.storage?.freeBytes ?? 0),
              changeDayBytes: addOptional(
                accumulator.storage.changeDayBytes,
                current.storage?.changeDayBytes,
              ),
              changeDaySampleHours: mergeSample(
                accumulator.storage.changeDaySampleHours,
                current.storage?.changeDaySampleHours,
              ),
              changeMonthBytes: addOptional(
                accumulator.storage.changeMonthBytes,
                current.storage?.changeMonthBytes,
              ),
              changeMonthCalendarBytes: addOptional(
                accumulator.storage.changeMonthCalendarBytes,
                current.storage?.changeMonthCalendarBytes,
              ),
              changeRangeBytes: addOptional(
                accumulator.storage.changeRangeBytes,
                current.storage?.changeRangeBytes,
              ),
              changeRangeSampleHours: mergeSample(
                accumulator.storage.changeRangeSampleHours,
                current.storage?.changeRangeSampleHours,
              ),
              changeRangeLabel:
                accumulator.storage.changeRangeLabel ?? current.storage?.changeRangeLabel,
            },
            contracts: mergeContracts(accumulator.contracts, current.contracts),
          };
        }

        return accumulator;
      },
      {
        current: { potential: 0, earned: 0 },
        currentMonth: { potential: 0, earned: 0 },
        total: { potential: 0, earned: 0 },
        storage: {
          usedBytes: 0,
          capacityBytes: 0,
          freeBytes: 0,
          changeDayBytes: undefined,
          changeDaySampleHours: undefined,
          changeMonthBytes: undefined,
          changeMonthCalendarBytes: undefined,
          changeRangeBytes: undefined,
          changeRangeSampleHours: undefined,
          changeRangeLabel: undefined,
        },
        contracts: undefined,
      },
    );
    // Unknown unless every node that answered knows its month: a partial sum would understate it.
    if (nodes.some((node) => node.status === 'ok' && !node.totals.currentMonth)) {
      aggregate.currentMonth = undefined;
    }

    return {
      periodStart: resolvedPeriodStart,
      periodEnd: config.periodEnd,
      periodMode: config.mode,
      periodLabel: config.periodLabel,
      periodShortLabel: config.periodShortLabel,
      previousPeriodStart: config.previousPeriodStart,
      rollingBaselineStart: config.rollingBaselineStart,
      nodes,
      aggregate,
    };
  }

  private getMockSiaSummary(options?: { month?: string; range?: SiaSummaryRange }): SiaSummary {
    // The period and its labels come from the same config as a live request, so a range such as
    // 7d spans its days and not the calendar month. "All" has no metric history to start from,
    // so it stays unbounded, as a live node without history.
    const config = this.buildSummaryRequestConfig(options);

    const mockNodes: SiaNodeStatus[] = [
      {
        host: 'demo-sia-1.example.com:9980',
        status: 'ok',
        metrics: [
          { metric: 'storage', current: { potential: 150, earned: 140 }, total: { potential: 300, earned: 280 } },
          { metric: 'ingress', current: { potential: 50, earned: 45 }, total: { potential: 100, earned: 90 } },
        ],
        totals: {
          current: { potential: 200, earned: 185 },
          currentMonth: { potential: 200, earned: 185 },
          total: { potential: 400, earned: 370 },
        },
        storage: {
          usedBytes: 1073741824, // 1 GB
          capacityBytes: 2147483648, // 2 GB
          freeBytes: 1073741824,
        },
        wallet: {
          confirmed: 1000,
          spendable: 950,
          unconfirmedIncoming: 10,
          unconfirmedOutgoing: 5,
        },
        contracts: {
          active: { currentCount: 5, deltaCount: 1 },
          successful: { currentCount: 20, deltaCount: 3 },
          renewed: { currentCount: 15, deltaCount: 2 },
          failed: { currentCount: 2, deltaCount: 0 },
        },
      },
      {
        host: 'demo-sia-2.example.com:9985',
        status: 'ok',
        metrics: [
          { metric: 'storage', current: { potential: 120, earned: 110 }, total: { potential: 250, earned: 220 } },
          { metric: 'egress', current: { potential: 30, earned: 25 }, total: { potential: 60, earned: 50 } },
        ],
        totals: {
          current: { potential: 150, earned: 135 },
          currentMonth: { potential: 150, earned: 135 },
          total: { potential: 310, earned: 270 },
        },
        storage: {
          usedBytes: 536870912, // 512 MB
          capacityBytes: 1073741824, // 1 GB
          freeBytes: 536870912,
        },
        wallet: {
          confirmed: 800,
          spendable: 780,
          unconfirmedIncoming: 5,
          unconfirmedOutgoing: 0,
        },
        contracts: {
          active: { currentCount: 3, deltaCount: 0 },
          successful: { currentCount: 18, deltaCount: 2 },
          renewed: { currentCount: 12, deltaCount: 1 },
          failed: { currentCount: 1, deltaCount: 0 },
        },
      },
      {
        host: 'demo-sia-3.example.com:9990',
        status: 'error',
        message: 'Connection timeout',
        errorKind: 'timeout',
        health: 'offline',
      },
    ];

    const aggregate = {
      current: { potential: 350, earned: 320 },
      currentMonth: { potential: 350, earned: 320 },
      total: { potential: 710, earned: 640 },
      storage: {
        usedBytes: 1610612736, // 1.5 GB
        capacityBytes: 3221225472, // 3 GB
        freeBytes: 1610612736,
      },
      contracts: {
        active: { currentCount: 8, deltaCount: 1 },
        successful: { currentCount: 38, deltaCount: 5 },
        renewed: { currentCount: 27, deltaCount: 3 },
        failed: { currentCount: 3, deltaCount: 0 },
      },
    };

    return {
      periodStart: config.periodStart,
      periodEnd: config.periodEnd,
      periodMode: config.mode,
      periodLabel: config.periodLabel,
      periodShortLabel: config.periodShortLabel,
      previousPeriodStart: config.previousPeriodStart,
      rollingBaselineStart: config.rollingBaselineStart,
      nodes: mockNodes.map((node) => ({ ...node, baseUrl: nodeBaseUrl(node.host) })),
      aggregate,
    };
  }
}
