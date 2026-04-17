import { Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'buffer';
import { getRuntimeEnv } from '../runtime-env';
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
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const ROLLING_WINDOW_DAYS = 30;
const ROLLING_WINDOW_BUFFER_DAYS = 2;

type HostdMetricPeriod = '5m' | '15m' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
type SiaSummaryRange = '1d' | '7d' | '1m' | '3m' | '1y' | 'all';

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

interface SiaNodeConfig {
  host: string;
  username?: string;
  password?: string;
  walletHost?: string;
}

@Injectable()
export class SiaService {
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
    const resolvedUsername = username ?? '';
    const resolvedPassword = password ?? '';
    const hasCredentials = resolvedUsername !== '' || resolvedPassword !== '';
    if (!hasCredentials) {
      return undefined;
    }

    const token = Buffer.from(`${resolvedUsername}:${resolvedPassword}`).toString('base64');
    return `Basic ${token}`;
  }

  private getConfiguredNode(host: string): SiaNodeConfig {
    const normalizedHost = host.trim();
    const node = this.configuredNodes.find((entry) => entry.host === normalizedHost);
    if (!node) {
      throw new NotFoundException(`Sia host ${normalizedHost} is not configured`);
    }

    return node;
  }

  private hastingsToSiacoins(hastings?: number | string): number {
    if (hastings === undefined || hastings === null) {
      return 0;
    }

    const numeric = typeof hastings === 'string' ? Number(hastings) : hastings;

    if (!numeric) {
      return 0;
    }

    return numeric / 10 ** 24;
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
      periodLabel: 'Current month',
      periodShortLabel: 'Current',
    };
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

  private pickMetricBaselineEntry(
    entries: HostdMetricEntry[] | undefined,
    targetIso: string,
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
      if (timestamp <= targetMs) {
        baseline = entry;
      } else {
        break;
      }
    }

    return baseline;
  }

  private buildCurrentMonthMetricSnapshot(
    entries: HostdMetricEntry[] | undefined,
    calendarBaselineStart: string,
  ): SiaMetricSnapshot | undefined {
    const ordered = this.orderMetricEntries(entries);
    if (!ordered || ordered.length < 2) {
      return undefined;
    }

    const currentEntry = ordered[ordered.length - 1];
    const targetMs = Date.parse(calendarBaselineStart);
    let baselineEntry = this.pickMetricBaselineEntry(ordered, calendarBaselineStart);

    if (!baselineEntry && Number.isFinite(targetMs)) {
      baselineEntry = ordered.find((entry) => {
        if (entry === currentEntry || !entry.timestamp) {
          return false;
        }
        const timestamp = Date.parse(entry.timestamp);
        return Number.isFinite(timestamp) && timestamp >= (targetMs as number);
      });
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
    const url = `http://${node.host}/api/settings/announce`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `announce request failed for ${url} with status ${response.status} ${response.statusText} ${raw.slice(
          0,
          200,
        )}`,
      );
    }

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

  private getLocalTimezoneOffsetMs(): number {
    return new Date().getTimezoneOffset() * 60 * 1000;
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
    const url = `http://${host}/api/metrics`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(
        `Storage metrics request failed for ${url} with status ${response.status} ${response.statusText} ${raw.slice(0, 200)}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Storage metrics response is not JSON for ${url}: ${raw.slice(0, 200)}`);
    }

    const payload = JSON.parse(raw) as {
      storage?: {
        totalSectors?: number | string;
        physicalSectors?: number | string;
      };
    };

    const totalSectors = Math.max(Number(payload.storage?.totalSectors ?? 0), 0);
    const usedSectors = Math.max(Number(payload.storage?.physicalSectors ?? 0), 0);

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
      : `http://${host}/api/`;

    const url = new URL(`metrics/${period}`, baseUrl);
    if (baseOverride && url.hostname.includes('api.sia.tech')) {
      url.searchParams.set('host', host);
    }
    if (start) {
      url.searchParams.set('start', start);
    }
    if (end) {
      url.searchParams.set('end', end);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `${period} metrics request failed for ${url.toString()} with status ${response.status} ${response.statusText} ${raw.slice(
          0,
          200,
        )}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        `${period} metrics response is not JSON from ${url.toString()}: ${raw.slice(0, 200)}`,
      );
    }

    try {
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload)) {
        throw new Error('payload is not an array');
      }
      return payload as HostdMetricEntry[];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown parse error';
      throw new Error(
        `${period} metrics JSON parse failed for ${url.toString()}: ${message}. Body: ${raw.slice(
          0,
          200,
        )}`,
      );
    }
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

  private computeStorageDelta(
    entries?: HostdMetricEntry[],
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (!entries || entries.length < 2) {
      return undefined;
    }

    const sanitized = entries
      .map((entry) => ({
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN,
        usedBytes: this.sectorsToBytes(entry.storage?.physicalSectors),
      }))
      .filter(
        (entry): entry is { timestamp: number; usedBytes: number } =>
          Number.isFinite(entry.timestamp) &&
          typeof entry.usedBytes === 'number' &&
          Number.isFinite(entry.usedBytes),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sanitized.length < 2) {
      return undefined;
    }

    const previous = sanitized[sanitized.length - 2];
    const latest = sanitized[sanitized.length - 1];
    const deltaBytes = latest.usedBytes - previous.usedBytes;
    const hoursRaw = (latest.timestamp - previous.timestamp) / MS_PER_HOUR;
    const sampleHours =
      Number.isFinite(hoursRaw) && hoursRaw > 0
        ? Math.max(Number(hoursRaw.toFixed(1)), 0)
        : undefined;

    return {
      deltaBytes,
      sampleHours,
    };
  }

  private computeLiveDelta(
    currentUsedBytes: number,
    entries: HostdMetricEntry[] | undefined,
    windowMs: number,
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (!entries || entries.length === 0 || !Number.isFinite(currentUsedBytes)) {
      return undefined;
    }

    const sanitized = entries
      .map((entry) => ({
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN,
        usedBytes: this.sectorsToBytes(entry.storage?.physicalSectors),
      }))
      .filter(
        (entry): entry is { timestamp: number; usedBytes: number } =>
          Number.isFinite(entry.timestamp) &&
          typeof entry.usedBytes === 'number' &&
          Number.isFinite(entry.usedBytes),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sanitized.length === 0) {
      return undefined;
    }

    const target = Date.now() - windowMs;

    let lower: { timestamp: number; usedBytes: number } | undefined;
    let upper: { timestamp: number; usedBytes: number } | undefined;

    for (const point of sanitized) {
      if (point.timestamp <= target) {
        lower = point;
      }

      if (point.timestamp >= target) {
        upper = point;
        break;
      }
    }

    if (!lower || !upper) {
      return undefined;
    }

    let baselineBytes = lower.usedBytes;
    let baselineTimestamp = lower.timestamp;

    if (upper.timestamp !== lower.timestamp) {
      const ratio = (target - lower.timestamp) / (upper.timestamp - lower.timestamp);
      baselineBytes =
        lower.usedBytes + (upper.usedBytes - lower.usedBytes) * Math.max(Math.min(ratio, 1), 0);
      baselineTimestamp = target;
    }

    const deltaBytes = currentUsedBytes - baselineBytes;
    const sampleHours = Math.max(
      Number(((Date.now() - baselineTimestamp) / MS_PER_HOUR).toFixed(1)),
      0,
    );

    return {
      deltaBytes,
      sampleHours,
    };
  }

  private computeWindowDeltaFromEntries(
    entries: HostdMetricEntry[] | undefined,
    windowMs: number,
  ): { deltaBytes: number; sampleHours?: number } | undefined {
    if (!entries || entries.length < 2) {
      return undefined;
    }

    const sanitized = entries
      .map((entry) => ({
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN,
        usedBytes: this.sectorsToBytes(entry.storage?.physicalSectors),
      }))
      .filter(
        (entry): entry is { timestamp: number; usedBytes: number } =>
          Number.isFinite(entry.timestamp) &&
          typeof entry.usedBytes === 'number' &&
          Number.isFinite(entry.usedBytes),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sanitized.length < 2) {
      return undefined;
    }

    const latest = sanitized[sanitized.length - 1];
    const target = latest.timestamp - windowMs;

    let lower: { timestamp: number; usedBytes: number } | undefined;
    let upper: { timestamp: number; usedBytes: number } | undefined;

    for (const point of sanitized) {
      if (point.timestamp <= target) {
        lower = point;
      }

      if (point.timestamp >= target) {
        upper = point;
        break;
      }
    }

    if (!lower || !upper) {
      return undefined;
    }

    let baselineBytes = lower.usedBytes;
    let baselineTimestamp = lower.timestamp;

    if (upper.timestamp !== lower.timestamp) {
      const ratio = (target - lower.timestamp) / (upper.timestamp - lower.timestamp);
      baselineBytes =
        lower.usedBytes + (upper.usedBytes - lower.usedBytes) * Math.max(Math.min(ratio, 1), 0);
      baselineTimestamp = target;
    }

    const deltaBytes = latest.usedBytes - baselineBytes;
    const sampleHours = Math.max(
      Number(((latest.timestamp - baselineTimestamp) / MS_PER_HOUR).toFixed(1)),
      0,
    );

    return {
      deltaBytes,
      sampleHours,
    };
  }

  private pickBaselineFromDaily(
    entries: HostdMetricEntry[] | undefined,
    baselineStartMs: number,
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
      if (timestamp >= baselineStartMs) {
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
  }): number | undefined {
    const orderedDailyEntries = params.orderedDailyEntries;
    const baselineMs = Date.parse(params.baselineStart);

    const dailyBaseline = this.pickBaselineFromDaily(orderedDailyEntries, baselineMs);
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
    },
  ): SiaStorageUsage {
    const enriched: SiaStorageUsage = { ...usage };

    const orderedDailyEntries = this.orderMetricEntries(options.dailyEntries);
    const orderedDayDeltaEntries = this.orderMetricEntries(options.dayDeltaEntries);
    const orderedMetricEntries = this.orderMetricEntries(options.metricEntries);

    const dailyDelta =
      this.computeWindowDeltaFromEntries(orderedDayDeltaEntries, MS_PER_DAY) ??
      this.computeLiveDelta(usage.usedBytes, orderedDayDeltaEntries, MS_PER_DAY) ??
      this.computeLiveDelta(usage.usedBytes, orderedDailyEntries, MS_PER_DAY) ??
      this.computeStorageDelta(orderedDailyEntries?.slice(-2));
    if (dailyDelta) {
      enriched.changeDayBytes = dailyDelta.deltaBytes;
      enriched.changeDaySampleHours = dailyDelta.sampleHours;
    }

    const rollingWindowMs = ROLLING_WINDOW_DAYS * MS_PER_DAY - this.getLocalTimezoneOffsetMs();
    const monthDelta =
      this.computeWindowDeltaFromEntries(orderedDailyEntries, rollingWindowMs) ?? undefined;

    if (monthDelta) {
      enriched.changeMonthBytes = monthDelta.deltaBytes;
    } else {
      const baselineBytes = this.resolveStorageBaselineBytes({
        orderedDailyEntries,
        baselineStart: options.rollingBaselineStart,
      });

      if (baselineBytes !== undefined) {
        enriched.changeMonthBytes = usage.usedBytes - baselineBytes;
      }
    }

    const calendarBaselineBytes = this.resolveStorageBaselineBytes({
      orderedDailyEntries,
      baselineStart: options.calendarBaselineStart,
    });

    if (calendarBaselineBytes !== undefined) {
      enriched.changeMonthCalendarBytes = usage.usedBytes - calendarBaselineBytes;
    }

    if (enriched.changeMonthBytes !== undefined) {
      enriched.changeMonthBaselineStart = options.rollingBaselineStart;
    }

    if (options.rangeWindowMs !== undefined && options.rangeWindowMs > 0) {
      const rangeDelta =
        this.computeWindowDeltaFromEntries(orderedDayDeltaEntries, options.rangeWindowMs) ??
        this.computeWindowDeltaFromEntries(orderedDailyEntries, options.rangeWindowMs) ??
        this.computeWindowDeltaFromEntries(orderedMetricEntries, options.rangeWindowMs) ??
        this.computeLiveDelta(usage.usedBytes, orderedDayDeltaEntries, options.rangeWindowMs) ??
        this.computeLiveDelta(usage.usedBytes, orderedDailyEntries, options.rangeWindowMs) ??
        this.computeLiveDelta(usage.usedBytes, orderedMetricEntries, options.rangeWindowMs);
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

  private async fetchWalletSummary(
    host: string,
    authorization?: string,
  ): Promise<SiaWalletSummary> {
    const response = await fetch(`http://${host}/wallet`, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });

    if (!response.ok) {
      throw new Error(`Wallet request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      confirmedSiacoinBalance?: number | string;
      spendableSiacoinBalance?: number | string;
      unconfirmedIncomingSiacoinBalance?: number | string;
      unconfirmedOutgoingSiacoinBalance?: number | string;
    };

    const toSiacoin = (value?: number | string): number => {
      if (value === undefined || value === null) {
        return 0;
      }
      const numeric = typeof value === 'string' ? Number(value) : value;
      return this.hastingsToSiacoins(numeric);
    };

    return {
      confirmed: toSiacoin(payload.confirmedSiacoinBalance),
      spendable: toSiacoin(payload.spendableSiacoinBalance),
      unconfirmedIncoming: toSiacoin(payload.unconfirmedIncomingSiacoinBalance),
      unconfirmedOutgoing: toSiacoin(payload.unconfirmedOutgoingSiacoinBalance),
    };
  }

  async fetchSummary(options?: { month?: string; range?: SiaSummaryRange }): Promise<SiaSummary> {
    const config = this.buildSummaryRequestConfig(options);
    const calendarBaselineStart =
      config.mode === 'calendar' ? config.periodStart : this.getPeriodStart();

    const nodeResults = await Promise.all(
      this.configuredNodes.map(async (nodeConfig): Promise<SiaNodeComputation> => {
        const host = nodeConfig.host;
        const authorization = this.buildAuthorizationHeader(
          nodeConfig.username,
          nodeConfig.password,
        );

        try {
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

          const orderedMetricEntries = this.orderMetricEntries(metricEntries);
          if (!orderedMetricEntries || orderedMetricEntries.length === 0) {
            throw new Error(`${config.metricPeriod} metrics payload is incomplete`);
          }

          const currentEntry = orderedMetricEntries[orderedMetricEntries.length - 1];
          let baselineEntry: HostdMetricEntry | undefined;
          let resolvedPeriodStart = config.periodStart;

          if (config.mode === 'calendar') {
            if (orderedMetricEntries.length < 2) {
              throw new Error('Monthly metrics payload is incomplete');
            }
            baselineEntry = orderedMetricEntries[orderedMetricEntries.length - 2];
          } else if (config.range === 'all') {
            resolvedPeriodStart = this.getEarliestMetricTimestamp(orderedMetricEntries) ?? '';
          } else {
            baselineEntry = this.pickMetricBaselineEntry(orderedMetricEntries, config.periodStart);
          }

          const { metrics, totals } = this.buildMetricRowsFromSnapshots(currentEntry, baselineEntry);
          let currentMonthSnapshot: SiaMetricSnapshot = totals.current;
          if (config.mode === 'range') {
            currentMonthSnapshot =
              this.buildCurrentMonthMetricSnapshot(dailyEntries, calendarBaselineStart) ??
              this.buildCurrentMonthMetricSnapshot(orderedMetricEntries, calendarBaselineStart) ??
              this.buildCurrentMonthMetricSnapshot(
                currentMonthMetricEntries,
                calendarBaselineStart,
              ) ??
              { potential: 0, earned: 0 };
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
          const walletHost = nodeConfig.walletHost ?? host;
          try {
            wallet = await this.fetchWalletSummary(walletHost, authorization);
            if (lockedCollateral !== undefined) {
              wallet.lockedCollateral = lockedCollateral;
            }
          } catch (error) {
            wallet = undefined;
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
              host,
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
          const message = error instanceof Error ? error.message : 'Unknown error';

          return {
            node: {
              host,
              status: 'error',
              message,
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
}
