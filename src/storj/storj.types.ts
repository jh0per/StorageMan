export interface StorjPayoutSnapshot {
  grossUsd: number;
  heldUsd: number;
  netUsd: number;
  distributedUsd?: number;
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
  status: 'error';
  message: string;
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
