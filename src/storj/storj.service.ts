import { Injectable } from '@nestjs/common';
import { getRuntimeEnv } from '../runtime-env';
import {
  StorjAuditScore,
  StorjAuditSummary,
  StorjBandwidthMonthly,
  StorjBandwidthStats,
  StorjDiskUsage,
  StorjNodeStatus,
  StorjQuicStatus,
  StorjSummary,
} from './storj.types';

const MS_PER_HOUR = 60 * 60 * 1000;
const STORJ_PAYSTUB_RANGE_START = '2019-01';

export type StorjSummaryRange = '1d' | '7d' | '1m' | '3m' | '1y' | 'all';

interface StorageDailyEntry {
  timestamp: number;
  usedBytes: number;
}

interface BandwidthDailyEntry {
  timestamp: number;
  totalBytes: number;
  ingressBytes: number;
  egressBytes: number;
  repairIngressBytes: number;
  repairEgressBytes: number;
  repairBytes: number;
  auditBytes: number;
}

interface PaystubTotals {
  paid: number;
  held: number;
  distributed: number;
}

interface StorjNodeConfig {
  host: string;
}

@Injectable()
export class StorjService {
  private get sharedHosts(): string[] {
    const raw = getRuntimeEnv('STORJ_HOSTS');
    if (!raw) {
      return [];
    }

    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private get configuredNodes(): StorjNodeConfig[] {
    const raw = getRuntimeEnv('STORJ_NODES_JSON')?.trim();
    if (!raw) {
      return this.sharedHosts.map((host) => ({ host }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('STORJ_NODES_JSON is not valid JSON');
    }

    const rawNodes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { nodes?: unknown[] }).nodes)
        ? (parsed as { nodes: unknown[] }).nodes
        : null;

    if (!rawNodes) {
      throw new Error('STORJ_NODES_JSON must be a JSON array or an object with a nodes array');
    }

    return rawNodes
      .map((entry): StorjNodeConfig | undefined => {
        if (typeof entry === 'string') {
          const host = entry.trim();
          return host ? { host } : undefined;
        }

        if (!entry || typeof entry !== 'object') {
          return undefined;
        }

        const host = String((entry as Record<string, unknown>).host ?? '').trim();
        return host ? { host } : undefined;
      })
      .filter((entry): entry is StorjNodeConfig => Boolean(entry));
  }

  private extractDollar(value?: number | null): number {
    if (!value) {
      return 0;
    }
    return value / 100;
  }

  private computeSnapshot(entry?: {
    egressBandwidthPayout?: number;
    egressRepairAuditPayout?: number;
    diskSpacePayout?: number;
    held?: number;
    payout?: number;
  }): { grossUsd: number; heldUsd: number; netUsd: number } {
    if (!entry) {
      return {
        grossUsd: 0,
        heldUsd: 0,
        netUsd: 0,
      };
    }

    const gross =
      this.extractDollar(entry.egressBandwidthPayout) +
      this.extractDollar(entry.egressRepairAuditPayout) +
      this.extractDollar(entry.diskSpacePayout);

    return {
      grossUsd: gross,
      heldUsd: this.extractDollar(entry.held),
      netUsd: this.extractDollar(entry.payout),
    };
  }

  private getPaystubRangeStart(): string {
    return STORJ_PAYSTUB_RANGE_START;
  }

  private getPaystubRangeEnd(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  private parseMicroDollar(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }
    const numeric = typeof value === 'string' ? Number(value) : (value as number);
    if (Number.isNaN(numeric)) {
      return 0;
    }

    return numeric / 1_000_000;
  }

  private async fetchPaystubTotals(host: string): Promise<PaystubTotals> {
    const start = this.getPaystubRangeStart();
    const end = this.getPaystubRangeEnd();
    const url = `http://${host}/api/heldamount/paystubs/${start}/${end}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Paystub request failed with status ${response.status}`);
    }

    const stubs = (await response.json()) as Array<Record<string, unknown>>;
    const totals = stubs.reduce<PaystubTotals>(
      (accumulator, current) => {
        accumulator.paid += this.parseMicroDollar(current.paid);
        accumulator.held += this.parseMicroDollar(current.held);
        accumulator.distributed += this.parseMicroDollar(current.distributed ?? current.returned);
        return accumulator;
      },
      { paid: 0, held: 0, distributed: 0 },
    );

    return totals;
  }

  private async fetchNodeStats(host: string): Promise<any> {
    const url = `http://${host}/api/sno/`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Node stats request failed with status ${response.status}`);
    }

    return response.json();
  }

  private extractDiskUsage(payload: {
    diskSpace?: {
      used?: number;
      available?: number;
      allocated?: number;
      trash?: number;
      overused?: number;
    };
  }): StorjDiskUsage {
    const diskSpace = payload?.diskSpace;
    if (!diskSpace) {
      throw new Error('Response missing diskSpace information.');
    }

    const used = Number(diskSpace.used ?? 0);
    const available = Number(diskSpace.available ?? 0);
    const allocated = Number(diskSpace.allocated ?? 0);
    const trash = Number(diskSpace.trash ?? 0);
    const capacity = allocated > 0 ? allocated : Math.max(available + used + trash, 0);
    const free = allocated > 0 ? Math.max(available, 0) : Math.max(capacity - (used + trash), 0);

    return {
      usedBytes: used,
      availableBytes: capacity,
      trashBytes: trash,
      freeBytes: free,
    };
  }

  private normalizeQuicStatus(value: unknown): StorjQuicStatus | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'boolean') {
      return value ? 'ok' : 'misconfigured';
    }

    if (typeof value === 'number') {
      return value > 0 ? 'ok' : 'misconfigured';
    }

    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (!text) {
        return undefined;
      }
      if (text.includes('ok') || text.includes('healthy') || text.includes('enabled')) {
        return 'ok';
      }
      if (text.includes('offline') || text.includes('unreachable')) {
        return 'offline';
      }
      if (
        text.includes('misconfig') ||
        text.includes('error') ||
        text.includes('fail') ||
        text.includes('disabled')
      ) {
        return 'misconfigured';
      }
      return undefined;
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = ['status', 'state', 'result', 'ok', 'enabled', 'active', 'available'];
      for (const key of keys) {
        if (record[key] !== undefined) {
          const normalized = this.normalizeQuicStatus(record[key]);
          if (normalized) {
            return normalized;
          }
        }
      }

      if (record.error) {
        return 'misconfigured';
      }

      if (record.message) {
        return this.normalizeQuicStatus(record.message);
      }
    }

    return undefined;
  }

  private extractQuicStatus(payload: Record<string, unknown>): StorjQuicStatus | undefined {
    const candidates = [
      payload?.quic,
      payload?.quicStatus,
      payload?.quic_status,
      (payload?.transport as Record<string, unknown> | undefined)?.quic,
      (payload?.network as Record<string, unknown> | undefined)?.quic,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeQuicStatus(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  private extractBandwidthSection(source: any): number | undefined {
    if (source === undefined || source === null) {
      return undefined;
    }

    if (typeof source === 'number') {
      return Number.isFinite(source) ? source : undefined;
    }

    if (typeof source === 'string') {
      const numeric = Number(source);
      return Number.isFinite(numeric) ? numeric : undefined;
    }

    if (typeof source === 'object') {
      const total = this.extractBandwidthSection((source as Record<string, unknown>).total);
      if (total !== undefined) {
        return total;
      }

      const keys = ['usage', 'repair', 'audit', 'ingress', 'egress', 'compaction'];
      let sum = 0;
      let found = false;
      keys.forEach((key) => {
        const value = this.extractBandwidthSection((source as Record<string, unknown>)[key]);
        if (value !== undefined) {
          sum += value;
          found = true;
        }
      });
      return found ? sum : undefined;
    }

    return undefined;
  }

  private extractBandwidthStats(payload: any): StorjBandwidthStats | undefined {
    const dailyEntries = Array.isArray(payload?.bandwidthDaily)
      ? payload.bandwidthDaily
      : Array.isArray(payload?.bandwidth?.daily)
        ? payload.bandwidth.daily
        : undefined;

    if (!dailyEntries || dailyEntries.length === 0) {
      return undefined;
    }

    const latest = dailyEntries[dailyEntries.length - 1];
    if (!latest || typeof latest !== 'object') {
      return undefined;
    }

    const ingressBytes =
      this.extractBandwidthSection((latest as any).ingress) ??
      this.extractBandwidthSection((latest as any).ingressBandwidth);
    const egressBytes =
      this.extractBandwidthSection((latest as any).egress) ??
      this.extractBandwidthSection((latest as any).egressBandwidth);
    const repairIngressBytes =
      this.extractBandwidthSection((latest as any).repairIngress) ??
      this.extractBandwidthSection((latest as any).ingress?.repair);
    const repairEgressBytes =
      this.extractBandwidthSection((latest as any).repairEgress) ??
      this.extractBandwidthSection((latest as any).egress?.repair);

    if (
      ingressBytes === undefined &&
      egressBytes === undefined &&
      repairIngressBytes === undefined &&
      repairEgressBytes === undefined
    ) {
      return undefined;
    }

    return {
      ingressBytes,
      egressBytes,
      repairIngressBytes,
      repairEgressBytes,
    };
  }

  private parseStorageDailyEntries(payload: any): StorageDailyEntry[] {
    const dailyEntries = Array.isArray(payload?.storageDaily)
      ? (payload.storageDaily as Array<Record<string, unknown>>)
      : [];
    const sanitized = dailyEntries
      .map((entry): StorageDailyEntry | undefined => {
        if (!entry || typeof entry !== 'object') {
          return undefined;
        }
        const usedRaw = entry.atRestTotalBytes;
        const used =
          typeof usedRaw === 'string' ? Number(usedRaw) : (usedRaw as number | undefined);
        if (!Number.isFinite(used ?? NaN)) {
          return undefined;
        }
        const timestamp = Date.parse(String(entry.intervalStart ?? ''));
        if (!Number.isFinite(timestamp)) {
          return undefined;
        }
        return { timestamp, usedBytes: used ?? 0 };
      })
      .filter((entry): entry is StorageDailyEntry => Boolean(entry))
      .sort((a: StorageDailyEntry, b: StorageDailyEntry) => a.timestamp - b.timestamp);

    return sanitized;
  }

  private parseBandwidthDailyEntries(payload: any): BandwidthDailyEntry[] {
    const dailyEntries = Array.isArray(payload?.bandwidthDaily)
      ? (payload.bandwidthDaily as Array<Record<string, unknown>>)
      : [];

    return dailyEntries
      .map((entry): BandwidthDailyEntry | undefined => {
        if (!entry || typeof entry !== 'object') {
          return undefined;
        }

        const timestamp = Date.parse(String(entry.intervalStart ?? ''));
        if (!Number.isFinite(timestamp)) {
          return undefined;
        }

        const egress = entry.egress as Record<string, unknown> | undefined;
        const ingress = entry.ingress as Record<string, unknown> | undefined;
        const egressUsageBytes = this.extractBandwidthSection(egress?.usage) ?? 0;
        const egressRepairBytes = this.extractBandwidthSection(egress?.repair) ?? 0;
        const auditBytes = this.extractBandwidthSection(egress?.audit) ?? 0;
        const ingressUsageBytes = this.extractBandwidthSection(ingress?.usage) ?? 0;
        const ingressRepairBytes = this.extractBandwidthSection(ingress?.repair) ?? 0;
        const egressBytes = egressUsageBytes + egressRepairBytes + auditBytes;
        const ingressBytes = ingressUsageBytes + ingressRepairBytes;
        const repairBytes = ingressRepairBytes + egressRepairBytes;
        const totalBytes = ingressBytes + egressBytes;

        return {
          timestamp,
          totalBytes,
          ingressBytes,
          egressBytes,
          repairIngressBytes: ingressRepairBytes,
          repairEgressBytes: egressRepairBytes,
          repairBytes,
          auditBytes,
        };
      })
      .filter((entry): entry is BandwidthDailyEntry => Boolean(entry))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private computeBandwidthDailySummary(
    entries: BandwidthDailyEntry[],
  ): StorjBandwidthStats | undefined {
    if (entries.length === 0) {
      return undefined;
    }

    const latest = entries[entries.length - 1];
    const previous = entries.length > 1 ? entries[entries.length - 2] : undefined;
    const sampleHours = previous
      ? Math.max(Number(((latest.timestamp - previous.timestamp) / MS_PER_HOUR).toFixed(1)), 0)
      : undefined;

    return {
      totalBytes: latest.totalBytes,
      ingressBytes: latest.ingressBytes,
      egressBytes: latest.egressBytes,
      repairIngressBytes: latest.repairIngressBytes,
      repairEgressBytes: latest.repairEgressBytes,
      repairBytes: latest.repairBytes,
      auditBytes: latest.auditBytes,
      changeTotalBytes: previous ? latest.totalBytes - previous.totalBytes : undefined,
      changeIngressBytes: previous ? latest.ingressBytes - previous.ingressBytes : undefined,
      changeEgressBytes: previous ? latest.egressBytes - previous.egressBytes : undefined,
      changeRepairBytes: previous ? latest.repairBytes - previous.repairBytes : undefined,
      changeAuditBytes: previous ? latest.auditBytes - previous.auditBytes : undefined,
      changeSampleHours: sampleHours,
    };
  }

  private computeSatelliteStorageAverages(entries: StorageDailyEntry[]): {
    satelliteDailyAverageBytes?: number;
    satelliteDayChangeBytes?: number;
    satelliteDaySampleHours?: number;
    satelliteMonthAverageBytes?: number;
    satelliteMonthChangeBytes?: number;
  } {
    if (entries.length === 0) {
      return {};
    }

    const latest = entries[entries.length - 1];
    const previous = entries.length > 1 ? entries[entries.length - 2] : undefined;
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);
    const nextMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0);
    const monthEntries = entries.filter(
      (entry) => entry.timestamp >= monthStart && entry.timestamp < nextMonthStart,
    );
    const satelliteMonthAverageBytes =
      monthEntries.length > 0
        ? monthEntries.reduce((sum, entry) => sum + entry.usedBytes, 0) / monthEntries.length
        : undefined;
    const monthBaseline = monthEntries.find((entry) => entry.timestamp < latest.timestamp);
    const daySampleHours = previous
      ? Math.max(Number(((latest.timestamp - previous.timestamp) / MS_PER_HOUR).toFixed(1)), 0)
      : undefined;

    return {
      satelliteDailyAverageBytes: latest.usedBytes,
      satelliteDayChangeBytes: previous ? latest.usedBytes - previous.usedBytes : undefined,
      satelliteDaySampleHours: daySampleHours,
      satelliteMonthAverageBytes,
      satelliteMonthChangeBytes: monthBaseline ? latest.usedBytes - monthBaseline.usedBytes : undefined,
    };
  }

  private parseBandwidthMonth(payload: any): StorjBandwidthMonthly | undefined {
    const total = Number(payload?.bandwidthSummary);
    const ingress = Number(payload?.ingressSummary);
    const egress = Number(payload?.egressSummary);

    const totalBytes = Number.isFinite(total) ? total : undefined;
    const ingressBytes = Number.isFinite(ingress) ? ingress : undefined;
    const egressBytes = Number.isFinite(egress) ? egress : undefined;

    if (totalBytes === undefined && ingressBytes === undefined && egressBytes === undefined) {
      return undefined;
    }

    return { totalBytes, ingressBytes, egressBytes };
  }

  private parseAuditEntries(payload: any): StorjAuditScore[] {
    const raw = Array.isArray(payload?.audits)
      ? (payload.audits as Array<Record<string, unknown>>)
      : [];

    return raw
      .map((entry): StorjAuditScore | undefined => {
        if (!entry || typeof entry !== 'object') {
          return undefined;
        }
        const auditScore = Number(entry.auditScore);
        const suspensionScore = Number(entry.suspensionScore);
        const onlineScore = Number(entry.onlineScore);
        const satelliteName = String(entry.satelliteName ?? '').trim();
        if (!satelliteName || !Number.isFinite(auditScore) || !Number.isFinite(suspensionScore)) {
          return undefined;
        }
        return {
          satelliteName,
          auditScore,
          suspensionScore,
          onlineScore: Number.isFinite(onlineScore) ? onlineScore : undefined,
        };
      })
      .filter((entry): entry is StorjAuditScore => Boolean(entry));
  }

  private computeAuditSummary(entries: StorjAuditScore[]): StorjAuditSummary | undefined {
    if (!entries.length) {
      return undefined;
    }

    let minAudit = Number.POSITIVE_INFINITY;
    let minSuspension = Number.POSITIVE_INFINITY;
    let minOnline: number | undefined;

    entries.forEach((entry) => {
      minAudit = Math.min(minAudit, entry.auditScore);
      minSuspension = Math.min(minSuspension, entry.suspensionScore);
      const onlineScore = entry.onlineScore;
      if (typeof onlineScore === 'number' && Number.isFinite(onlineScore)) {
        minOnline = minOnline === undefined ? onlineScore : Math.min(minOnline, onlineScore);
      }
    });

    if (!Number.isFinite(minAudit) || !Number.isFinite(minSuspension)) {
      return undefined;
    }

    return {
      auditScore: minAudit,
      suspensionScore: minSuspension,
      onlineScore: minOnline,
    };
  }

  private async fetchSatelliteSnapshot(host: string): Promise<{
    storageDaily: StorageDailyEntry[];
    bandwidthDaily?: StorjBandwidthStats;
    bandwidthMonth?: StorjBandwidthMonthly;
    audits: StorjAuditScore[];
    auditSummary?: StorjAuditSummary;
  }> {
    const url = `http://${host}/api/sno/satellites`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Satellite stats request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const storageDaily = this.parseStorageDailyEntries(payload);
    const bandwidthDaily = this.computeBandwidthDailySummary(
      this.parseBandwidthDailyEntries(payload),
    );
    const bandwidthMonth = this.parseBandwidthMonth(payload);
    const audits = this.parseAuditEntries(payload);
    const auditSummary = this.computeAuditSummary(audits);
    return { storageDaily, bandwidthDaily, bandwidthMonth, audits, auditSummary };
  }

  async fetchSummary(options?: { range?: StorjSummaryRange }): Promise<StorjSummary> {
    if (process.env.DEMO_MODE === 'true') {
      return this.getMockStorjSummary(options);
    }

    void options;
    const nodes = await Promise.all(
      this.configuredNodes.map(async (nodeConfig): Promise<StorjNodeStatus> => {
        const host = nodeConfig.host;
        const url = `http://${host}/api/sno/estimated-payout`;

        try {
          const response = await fetch(url);

          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
          }

          const payload = (await response.json()) as Record<string, any>;

          const current = payload.currentMonth as
            | {
                egressBandwidthPayout?: number;
                egressRepairAuditPayout?: number;
                diskSpacePayout?: number;
                held?: number;
                payout?: number;
              }
            | undefined;
          const lifetimeEntry =
            (payload.lifetimePayout as Record<string, any> | undefined) ??
            (payload.lifetime as Record<string, any> | undefined) ??
            (payload.allTime as Record<string, any> | undefined) ??
            (payload.cumulative as Record<string, any> | undefined);
          const previousEntry = payload.previousMonth as
            | {
                egressBandwidthPayout?: number;
                egressRepairAuditPayout?: number;
                diskSpacePayout?: number;
                held?: number;
                payout?: number;
              }
            | undefined;

          if (!current) {
            throw new Error('Response missing currentMonth data.');
          }

          const currentSnapshot = this.computeSnapshot(current);
          const lifetimeSnapshot = lifetimeEntry ? this.computeSnapshot(lifetimeEntry) : undefined;
          const previousSnapshot = previousEntry ? this.computeSnapshot(previousEntry) : undefined;

          let paystubTotals: PaystubTotals | undefined;
          try {
            paystubTotals = await this.fetchPaystubTotals(host);
          } catch {
            paystubTotals = undefined;
          }

          let diskUsage: StorjDiskUsage | undefined;
          let bandwidth: StorjBandwidthStats | undefined;
          let bandwidthMonth: StorjBandwidthMonthly | undefined;
          let audits: StorjAuditScore[] | undefined;
          let auditSummary: StorjAuditSummary | undefined;
          let quicStatus: StorjQuicStatus | undefined;
          try {
            const nodeStats = await this.fetchNodeStats(host);
            const snapshot = this.extractDiskUsage(nodeStats);
            bandwidth = this.extractBandwidthStats(nodeStats);
            diskUsage = snapshot;
            quicStatus = this.extractQuicStatus(nodeStats);

            try {
              const satelliteSnapshot = await this.fetchSatelliteSnapshot(host);
              if (satelliteSnapshot.storageDaily.length > 0) {
                const storageAverages = this.computeSatelliteStorageAverages(
                  satelliteSnapshot.storageDaily,
                );
                diskUsage = { ...snapshot, ...storageAverages };
              }
              bandwidth = satelliteSnapshot.bandwidthDaily ?? bandwidth;
              bandwidthMonth = satelliteSnapshot.bandwidthMonth;
              audits =
                satelliteSnapshot.audits.length > 0 ? satelliteSnapshot.audits : undefined;
              auditSummary = satelliteSnapshot.auditSummary;
            } catch {
              // Keep base disk usage if storage history is unavailable.
            }
          } catch {
            diskUsage = undefined;
            bandwidth = undefined;
          }

          const totalSnapshot = (() => {
            if (paystubTotals) {
              return {
                grossUsd: paystubTotals.paid + paystubTotals.distributed,
                heldUsd: paystubTotals.held,
                netUsd: paystubTotals.paid,
                distributedUsd: paystubTotals.distributed,
              };
            }

            if (!lifetimeSnapshot) {
              if (!previousSnapshot) {
                return currentSnapshot;
              }

              return {
                grossUsd: previousSnapshot.grossUsd + currentSnapshot.grossUsd,
                heldUsd: previousSnapshot.heldUsd + currentSnapshot.heldUsd,
                netUsd: previousSnapshot.netUsd + currentSnapshot.netUsd,
              };
            }

            const includesCurrent =
              lifetimeSnapshot.netUsd >= currentSnapshot.netUsd &&
              lifetimeSnapshot.grossUsd >= currentSnapshot.grossUsd;

            if (includesCurrent) {
              return lifetimeSnapshot;
            }

            return {
              grossUsd: lifetimeSnapshot.grossUsd + currentSnapshot.grossUsd,
              heldUsd: lifetimeSnapshot.heldUsd + currentSnapshot.heldUsd,
              netUsd: lifetimeSnapshot.netUsd + currentSnapshot.netUsd,
            };
          })();

          return {
            host,
            status: 'ok',
            current: currentSnapshot,
            total: totalSnapshot,
            disk: diskUsage,
            bandwidth,
            bandwidthMonth,
            audits,
            auditSummary,
            quicStatus,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';

          return {
            host,
            status: 'error',
            message,
          };
        }
      }),
    );

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

    const aggregate = nodes.reduce<StorjSummary['aggregate']>(
      (accumulator, current) => {
        if (current.status === 'ok') {
          return {
            current: {
              grossUsd: accumulator.current.grossUsd + current.current.grossUsd,
              netUsd: accumulator.current.netUsd + current.current.netUsd,
              heldUsd: accumulator.current.heldUsd + current.current.heldUsd,
              distributedUsd:
                (accumulator.current.distributedUsd ?? 0) + (current.current.distributedUsd ?? 0),
            },
            total: {
              grossUsd: accumulator.total.grossUsd + current.total.grossUsd,
              netUsd: accumulator.total.netUsd + current.total.netUsd,
              heldUsd: accumulator.total.heldUsd + current.total.heldUsd,
              distributedUsd:
                (accumulator.total.distributedUsd ?? 0) + (current.total.distributedUsd ?? 0),
            },
            disk: {
              usedBytes: accumulator.disk.usedBytes + (current.disk?.usedBytes ?? 0),
              availableBytes: accumulator.disk.availableBytes + (current.disk?.availableBytes ?? 0),
              trashBytes: accumulator.disk.trashBytes + (current.disk?.trashBytes ?? 0),
              freeBytes: accumulator.disk.freeBytes + (current.disk?.freeBytes ?? 0),
              satelliteDailyAverageBytes: addOptional(
                accumulator.disk.satelliteDailyAverageBytes,
                current.disk?.satelliteDailyAverageBytes,
              ),
              satelliteDayChangeBytes: addOptional(
                accumulator.disk.satelliteDayChangeBytes,
                current.disk?.satelliteDayChangeBytes,
              ),
              satelliteDaySampleHours: mergeSample(
                accumulator.disk.satelliteDaySampleHours,
                current.disk?.satelliteDaySampleHours,
              ),
              satelliteMonthAverageBytes: addOptional(
                accumulator.disk.satelliteMonthAverageBytes,
                current.disk?.satelliteMonthAverageBytes,
              ),
              satelliteMonthChangeBytes: addOptional(
                accumulator.disk.satelliteMonthChangeBytes,
                current.disk?.satelliteMonthChangeBytes,
              ),
              changeDayBytes: addOptional(
                accumulator.disk.changeDayBytes,
                current.disk?.changeDayBytes,
              ),
              changeDaySampleHours: mergeSample(
                accumulator.disk.changeDaySampleHours,
                current.disk?.changeDaySampleHours,
              ),
              changeMonthCalendarBytes: addOptional(
                accumulator.disk.changeMonthCalendarBytes,
                current.disk?.changeMonthCalendarBytes,
              ),
              changeMonthBytes: addOptional(
                accumulator.disk.changeMonthBytes,
                current.disk?.changeMonthBytes,
              ),
            },
            bandwidth: {
              totalBytes: addOptional(
                accumulator.bandwidth?.totalBytes,
                current.bandwidth?.totalBytes,
              ),
              ingressBytes: addOptional(
                accumulator.bandwidth?.ingressBytes,
                current.bandwidth?.ingressBytes,
              ),
              egressBytes: addOptional(
                accumulator.bandwidth?.egressBytes,
                current.bandwidth?.egressBytes,
              ),
              repairIngressBytes: addOptional(
                accumulator.bandwidth?.repairIngressBytes,
                current.bandwidth?.repairIngressBytes,
              ),
              repairEgressBytes: addOptional(
                accumulator.bandwidth?.repairEgressBytes,
                current.bandwidth?.repairEgressBytes,
              ),
              repairBytes: addOptional(
                accumulator.bandwidth?.repairBytes,
                current.bandwidth?.repairBytes,
              ),
              auditBytes: addOptional(
                accumulator.bandwidth?.auditBytes,
                current.bandwidth?.auditBytes,
              ),
              changeTotalBytes: addOptional(
                accumulator.bandwidth?.changeTotalBytes,
                current.bandwidth?.changeTotalBytes,
              ),
              changeIngressBytes: addOptional(
                accumulator.bandwidth?.changeIngressBytes,
                current.bandwidth?.changeIngressBytes,
              ),
              changeEgressBytes: addOptional(
                accumulator.bandwidth?.changeEgressBytes,
                current.bandwidth?.changeEgressBytes,
              ),
              changeRepairBytes: addOptional(
                accumulator.bandwidth?.changeRepairBytes,
                current.bandwidth?.changeRepairBytes,
              ),
              changeAuditBytes: addOptional(
                accumulator.bandwidth?.changeAuditBytes,
                current.bandwidth?.changeAuditBytes,
              ),
              changeSampleHours: mergeSample(
                accumulator.bandwidth?.changeSampleHours,
                current.bandwidth?.changeSampleHours,
              ),
            },
            bandwidthMonth: {
              totalBytes: addOptional(
                accumulator.bandwidthMonth?.totalBytes,
                current.bandwidthMonth?.totalBytes,
              ),
              ingressBytes: addOptional(
                accumulator.bandwidthMonth?.ingressBytes,
                current.bandwidthMonth?.ingressBytes,
              ),
              egressBytes: addOptional(
                accumulator.bandwidthMonth?.egressBytes,
                current.bandwidthMonth?.egressBytes,
              ),
            },
          };
        }

        return accumulator;
      },
      {
        current: { grossUsd: 0, netUsd: 0, heldUsd: 0, distributedUsd: 0 },
        total: { grossUsd: 0, netUsd: 0, heldUsd: 0, distributedUsd: 0 },
        disk: {
          usedBytes: 0,
          availableBytes: 0,
          trashBytes: 0,
          freeBytes: 0,
          satelliteDailyAverageBytes: undefined,
          satelliteDayChangeBytes: undefined,
          satelliteDaySampleHours: undefined,
          satelliteMonthAverageBytes: undefined,
          satelliteMonthChangeBytes: undefined,
          changeDayBytes: undefined,
          changeDaySampleHours: undefined,
          changeMonthCalendarBytes: undefined,
          changeMonthBytes: undefined,
        },
        bandwidth: undefined,
        bandwidthMonth: undefined,
      },
    );

    return {
      nodes,
      aggregate,
    };
  }

  private getMockStorjSummary(options?: { range?: StorjSummaryRange }): StorjSummary {
    const mockNodes: StorjNodeStatus[] = [
      {
        host: 'demo-storj-1.example.com:14002',
        status: 'ok',
        current: { grossUsd: 150, heldUsd: 10, netUsd: 140 },
        total: { grossUsd: 300, heldUsd: 20, netUsd: 280 },
        disk: {
          usedBytes: 1073741824, // 1 GB
          availableBytes: 2147483648, // 2 GB
          trashBytes: 0,
          freeBytes: 1073741824,
        },
        bandwidth: {
          totalBytes: 536870912, // 512 MB
          ingressBytes: 268435456,
          egressBytes: 268435456,
        },
        audits: [
          { satelliteName: 'us-central-1', auditScore: 1.0, suspensionScore: 1.0, onlineScore: 1.0 },
        ],
        auditSummary: { auditScore: 1.0, suspensionScore: 1.0, onlineScore: 1.0 },
        quicStatus: 'ok',
      },
      {
        host: 'demo-storj-2.example.com:14003',
        status: 'ok',
        current: { grossUsd: 120, heldUsd: 8, netUsd: 112 },
        total: { grossUsd: 250, heldUsd: 15, netUsd: 235 },
        disk: {
          usedBytes: 536870912, // 512 MB
          availableBytes: 1073741824, // 1 GB
          trashBytes: 0,
          freeBytes: 536870912,
        },
        bandwidth: {
          totalBytes: 268435456, // 256 MB
          ingressBytes: 134217728,
          egressBytes: 134217728,
        },
        audits: [
          { satelliteName: 'eu-west-1', auditScore: 0.99, suspensionScore: 1.0, onlineScore: 0.98 },
        ],
        auditSummary: { auditScore: 0.99, suspensionScore: 1.0, onlineScore: 0.98 },
        quicStatus: 'ok',
      },
      {
        host: 'demo-storj-3.example.com:14004',
        status: 'error',
        message: 'Connection refused',
      },
    ];

    const aggregate = {
      current: { grossUsd: 270, netUsd: 252, heldUsd: 18, distributedUsd: 0 },
      total: { grossUsd: 550, netUsd: 515, heldUsd: 35, distributedUsd: 0 },
      disk: {
        usedBytes: 1610612736, // 1.5 GB
        availableBytes: 3221225472, // 3 GB
        trashBytes: 0,
        freeBytes: 1610612736,
      },
      bandwidth: {
        totalBytes: 805306368, // 768 MB
        ingressBytes: 402653184,
        egressBytes: 402653184,
      },
      bandwidthMonth: {
        totalBytes: 1073741824, // 1 GB
        ingressBytes: 536870912,
        egressBytes: 536870912,
      },
    };

    return {
      nodes: mockNodes,
      aggregate,
    };
  }
}
