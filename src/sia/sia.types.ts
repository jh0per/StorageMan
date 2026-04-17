export interface SiaMetricSnapshot {
  potential: number;
  earned: number;
}

export interface SiaMetricRow {
  metric: string;
  current: SiaMetricSnapshot;
  total: SiaMetricSnapshot;
}

export interface SiaStorageUsage {
  usedBytes: number;
  capacityBytes: number;
  freeBytes: number;
  changeDayBytes?: number;
  changeDaySampleHours?: number;
  changeMonthBytes?: number;
  changeMonthBaselineStart?: string;
  changeMonthCalendarBytes?: number;
  changeRangeBytes?: number;
  changeRangeSampleHours?: number;
  changeRangeLabel?: string;
}

export interface SiaWalletSummary {
  confirmed: number;
  spendable: number;
  unconfirmedIncoming: number;
  unconfirmedOutgoing: number;
  lockedCollateral?: number;
}

export interface SiaContractStat {
  currentCount: number;
  deltaCount: number;
}

export interface SiaContractSummary {
  active: SiaContractStat;
  successful: SiaContractStat;
  renewed: SiaContractStat;
  failed: SiaContractStat;
}

export interface SiaNodeSuccess {
  host: string;
  status: 'ok';
  metrics: SiaMetricRow[];
  totals: {
    current: SiaMetricSnapshot;
    currentMonth?: SiaMetricSnapshot;
    total: SiaMetricSnapshot;
  };
  storage?: SiaStorageUsage;
  wallet?: SiaWalletSummary;
  contracts?: SiaContractSummary;
}

export interface SiaNodeFailure {
  host: string;
  status: 'error';
  message: string;
}

export type SiaNodeStatus = SiaNodeSuccess | SiaNodeFailure;

export interface SiaSummary {
  periodStart: string;
  periodEnd?: string;
  periodMode?: 'calendar' | 'range';
  periodLabel?: string;
  periodShortLabel?: string;
  previousPeriodStart?: string;
  rollingBaselineStart?: string;
  nodes: SiaNodeStatus[];
  aggregate: {
    current: SiaMetricSnapshot;
    currentMonth?: SiaMetricSnapshot;
    total: SiaMetricSnapshot;
    storage: SiaStorageUsage;
    contracts?: SiaContractSummary;
  };
}
