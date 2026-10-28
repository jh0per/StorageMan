import type { NodeErrorKind, NodeFailureHealth } from '../common/node-request';

/**
 * USD amounts of one period. For a lifetime total: gross = net + held balance, net is what the
 * paystubs record as paid (earned after held, held amount returned included; a month the
 * satellites hold back counts once it is paid) plus the open months' estimated payout, held is the
 * amount still withheld (held minus returned), distributed is what the satellites actually
 * transferred (it may include carried-over amounts and the next month's prepayment, so it is
 * neither a part of net nor added to it).
 */
export interface StorjPayoutSnapshot {
  grossUsd: number;
  heldUsd: number;
  netUsd: number;
  distributedUsd?: number;
  /**
   * Lifetime totals only: true when a month is missing from the total. For a node: its payout
   * history (paystubs) could not be read, so the total holds only the previous and current month,
   * or a month before the previous one has no paystubs yet. For the aggregate: any node's total
   * is partial, or a node failed and is left out of the sums.
   */
  isPartial?: boolean;
}

export interface StorjDiskUsage {
  usedBytes: number;
  availableBytes: number;
  trashBytes: number;
  freeBytes: number;
  satelliteDailyAverageBytes?: number;
  satelliteDayChangeBytes?: number;
  satelliteDaySampleHours?: number;
  satelliteMonthAverageBytes?: number;
  satelliteMonthChangeBytes?: number;
  changeDayBytes?: number;
  changeDaySampleHours?: number;
  changeMonthCalendarBytes?: number;
  changeMonthBytes?: number;
}

export interface StorjBandwidthStats {
  totalBytes?: number;
  ingressBytes?: number;
  egressBytes?: number;
  repairIngressBytes?: number;
  repairEgressBytes?: number;
  repairBytes?: number;
  auditBytes?: number;
  changeTotalBytes?: number;
  changeIngressBytes?: number;
  changeEgressBytes?: number;
  changeRepairBytes?: number;
  changeAuditBytes?: number;
  changeSampleHours?: number;
  /** UTC start of the complete day the change describes (compared with the day before it). */
  changeDayStart?: string;
}

export interface StorjBandwidthMonthly {
  totalBytes?: number;
  ingressBytes?: number;
  egressBytes?: number;
}

export interface StorjAuditScore {
  satelliteName: string;
  auditScore: number;
  suspensionScore: number;
  onlineScore?: number;
}

export interface StorjAuditSummary {
  auditScore: number;
  suspensionScore: number;
  onlineScore?: number;
}

export type StorjQuicStatus = 'ok' | 'misconfigured' | 'offline';

export interface StorjNodeSuccess {
  host: string;
  /** `scheme://host:port` of the node dashboard. */
  baseUrl?: string;
  status: 'ok';
  current: StorjPayoutSnapshot;
  total: StorjPayoutSnapshot;
  disk?: StorjDiskUsage;
  bandwidth?: StorjBandwidthStats;
  bandwidthMonth?: StorjBandwidthMonthly;
  audits?: StorjAuditScore[];
  auditSummary?: StorjAuditSummary;
  quicStatus?: StorjQuicStatus;
}

export interface StorjNodeFailure {
  host: string;
  baseUrl?: string;
  status: 'error';
  message: string;
  errorKind: NodeErrorKind;
  health: NodeFailureHealth;
}

export type StorjNodeStatus = StorjNodeSuccess | StorjNodeFailure;

export interface StorjSummary {
  nodes: StorjNodeStatus[];
  aggregate: {
    current: StorjPayoutSnapshot;
    total: StorjPayoutSnapshot;
    disk: StorjDiskUsage;
    bandwidth?: StorjBandwidthStats;
    bandwidthMonth?: StorjBandwidthMonthly;
  };
}
