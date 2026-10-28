import { microDollarsToDollars } from '../common/node-numbers';
import { StorjBandwidthStats, StorjPayoutSnapshot } from './storj.types';

const MS_PER_HOUR = 60 * 60 * 1000;

/** Sums of the paystubs of one `YYYY-MM` period, in USD. */
export interface PaystubMonth {
  /**
   * Released for payment: earned after the held amount was withheld, held amount returned
   * included. 0 for a month the satellites hold back.
   */
  paidUsd: number;
  heldUsd: number;
  /** Held amount returned to the operator. */
  disposedUsd: number;
  /**
   * What the satellites actually transferred. It can include amounts carried over from earlier
   * months (below the payout threshold) and the next month's prepayment, so it is not a part of
   * paid; it is reported on its own and never added to the totals.
   */
  distributedUsd: number;
  /** Satellites with a paystub for the period. */
  satellites: Set<string>;
}

/** Paystub sums of a node by `YYYY-MM` period (a paystub without a string period is under ''). */
export interface PaystubTotals {
  months: Map<string, PaystubMonth>;
}

export interface BandwidthDailyEntry {
  timestamp: number;
  totalBytes: number;
  ingressBytes: number;
  egressBytes: number;
  repairIngressBytes: number;
  repairEgressBytes: number;
  repairBytes: number;
  auditBytes: number;
}

/**
 * Sums `/api/heldamount/paystubs` (one paystub per satellite and month, amounts in micro-USD) by
 * period. Field names as in storagenode's `payouts.PayStub`.
 */
export function sumPaystubs(stubs: unknown[]): PaystubTotals {
  const months = new Map<string, PaystubMonth>();
  for (const entry of stubs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const stub = entry as Record<string, unknown>;
    const period = typeof stub.period === 'string' ? stub.period : '';
    let month = months.get(period);
    if (!month) {
      month = { paidUsd: 0, heldUsd: 0, disposedUsd: 0, distributedUsd: 0, satellites: new Set() };
      months.set(period, month);
    }
    month.paidUsd += microDollarsToDollars(stub.paid);
    month.heldUsd += microDollarsToDollars(stub.held);
    month.disposedUsd += microDollarsToDollars(stub.disposed);
    month.distributedUsd += microDollarsToDollars(stub.distributed);
    if (typeof stub.satelliteId === 'string' && stub.satelliteId) {
      month.satellites.add(stub.satelliteId);
    }
  }
  return { months };
}

/**
 * Whether [period] has a paystub from every satellite that has one for [earlier] (at least one
 * paystub when [earlier] has none).
 */
function isComplete(paystubs: PaystubTotals, period: string, earlier: string): boolean {
  const month = paystubs.months.get(period);
  if (!month) {
    return false;
  }
  const before = paystubs.months.get(earlier)?.satellites ?? new Set<string>();
  return [...before].every((satellite) => month.satellites.has(satellite));
}

/** Months since the year 0 of a `YYYY-MM` paystub period, or undefined when it is not such a month. */
function paystubMonthIndex(period: string): number | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) {
    return undefined;
  }
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? Number(match[1]) * 12 + month - 1 : undefined;
}

/**
 * Whether some satellite has no paystub for a month that lies between its own first and its own
 * newest paystub month, such as a period whose paystubs storagenode never fetched. A month missing
 * for every satellite is found that way too, as long as it lies inside some satellite's range. Not
 * detected here:
 * - months before a satellite's first paystub: they look like a satellite the node joined later,
 *   so months missing at the start of the history go unnoticed;
 * - months after a satellite's newest paystub: they look like a satellite the node left. The
 *   previous month is covered by [isComplete], and a history that ends before two months back for
 *   every satellite by the newest-month rule of the lifetime total;
 * - paystubs without a satellite id, or with a period that is not a `YYYY-MM` month: they are
 *   summed but belong to no satellite's range.
 * A month in which a satellite really issued no paystub between two it did issue cannot be told
 * from a missing one, and counts as a gap as well.
 */
export function hasSatelliteGap(paystubs: PaystubTotals): boolean {
  const monthsBySatellite = new Map<string, Set<number>>();
  for (const [period, month] of paystubs.months) {
    const index = paystubMonthIndex(period);
    if (index === undefined) {
      continue;
    }
    for (const satellite of month.satellites) {
      let indices = monthsBySatellite.get(satellite);
      if (!indices) {
        indices = new Set();
        monthsBySatellite.set(satellite, indices);
      }
      indices.add(index);
    }
  }
  return [...monthsBySatellite.values()].some(
    (indices) => Math.max(...indices) - Math.min(...indices) + 1 > indices.size,
  );
}

function sumOf(months: PaystubMonth[], amount: (month: PaystubMonth) => number): number {
  return months.reduce((sum, month) => sum + amount(month), 0);
}

/** `YYYY-MM` of a UTC month, the paystub `period` format. */
export function paystubPeriod(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of the UTC month before [now]. */
export function previousPaystubPeriod(now: Date): string {
  return paystubPeriod(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

/**
 * Whether the node's `previousMonth` estimate is the previous calendar month. storagenode computes
 * it for `now.UTC().AddDate(0, -1, 0)` (storagenode/payouts/estimatedpayouts/service.go,
 * `estimatedPayout`), and Go's AddDate normalises a day the shorter month lacks into the month
 * after it: on March 31 one month back is "February 31", which is March 3. So on a day of the month
 * past the previous month's last day (March 29-31, March 30-31 in a leap year, May 31, July 31,
 * October 31 and December 31) the estimate is the current month again. Decided by this server's
 * UTC date, like every period here.
 */
export function previousEstimateIsPreviousMonth(now: Date): boolean {
  const previousMonthLastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return now.getUTCDate() <= previousMonthLastDay.getUTCDate();
}

/**
 * Lifetime to date, the same definition whatever is available: every month with a paystub, plus
 * the estimated-payout months no paystub covers yet (the current month, and the previous one until
 * its paystubs are complete).
 *
 * From paystubs, as the storagenode dashboard's Total Earned and Total Held Amount: net = paid (what
 * the satellites released for payment: earned after held, held amount returned included), held
 * balance = held - disposed (disposed is held amount returned), gross = net + held balance (the
 * dashboard's paid + held - disposed per month). The open months add their estimate the same way:
 * net = payout, held = held, gross = earned. `owed` (earned - held + disposed) is not used: a month
 * the satellites hold back keeps its owed but records paid 0, and is counted once it is recorded as
 * paid. The real 2026-07 paystubs are such months: Storj's Chapter 11 court hold of July 1-26 2026.
 * Distributed is what was actually transferred: it includes amounts carried over from months below
 * the payout threshold and, since August 2026, the prepayment of the next month (on the 2026-07
 * paystubs it is the August prepayment, not July's owed), so it is reported on its own and never
 * added.
 *
 * The previous month's paystubs are complete once every satellite with a paystub two months back
 * has one for it too. Until then its estimate stands in for all of them: storagenode fetches that
 * month's paystubs one satellite at a time every 12 hours, skipping a satellite whose paystub is
 * not out yet, and the satellites publish theirs hours apart, so for a while only some are in. A
 * satellite the node has left makes the month incomplete as well, which only keeps the estimate
 * for that month.
 *
 * On some days the node's previous-month estimate is the current month again, and it is left out
 * (see [previousEstimateIsPreviousMonth]); the previous month then counts only from its paystubs,
 * as without an estimate.
 *
 * The total is marked `isPartial` instead of passing for a lifetime figure when a month is missing:
 * - without paystubs (the request failed) only the previous and the current month are known;
 * - a month before the previous one whose paystubs are not out yet is in neither the paystubs
 *   nor the estimate, which has only the previous and the current month (early on the 1st, the
 *   paystubs of two months back can still be missing). The newest paystub month is then older
 *   than two months back;
 * - without a (usable) previous-month estimate, the previous month counts only once its paystubs
 *   are complete;
 * - a satellite has no paystub for a month between its own first and newest paystub month (a
 *   period whose paystubs storagenode never fetched), see [hasSatelliteGap].
 * A node without any paystub is new (storagenode answers `null` for its paystub range), so it has
 * no such gap. Nor can a missing satellite be told in the first month a node has paystubs.
 */
export function computeLifetimeSnapshot(params: {
  current: StorjPayoutSnapshot;
  previous?: StorjPayoutSnapshot;
  paystubs?: PaystubTotals;
  now: Date;
}): StorjPayoutSnapshot {
  const { current, paystubs, now } = params;
  const previous = previousEstimateIsPreviousMonth(now) ? params.previous : undefined;
  const previousPeriod = previousPaystubPeriod(now);
  const previousComplete =
    paystubs !== undefined &&
    isComplete(
      paystubs,
      previousPeriod,
      paystubPeriod(now.getUTCFullYear(), now.getUTCMonth() - 2),
    );
  const previousOpen = previousComplete ? undefined : previous;
  const open = [previousOpen, current].filter(
    (snapshot): snapshot is StorjPayoutSnapshot => snapshot !== undefined,
  );
  const openGross = open.reduce((sum, snapshot) => sum + snapshot.grossUsd, 0);
  const openHeld = open.reduce((sum, snapshot) => sum + snapshot.heldUsd, 0);
  const openNet = open.reduce((sum, snapshot) => sum + snapshot.netUsd, 0);

  if (!paystubs) {
    return {
      grossUsd: openGross,
      heldUsd: openHeld,
      netUsd: openNet,
      distributedUsd: 0,
      isPartial: true,
    };
  }

  // The previous month's paystubs give way to its estimate while they are incomplete.
  const counted = [...paystubs.months]
    .filter(([period]) => previousOpen === undefined || period !== previousPeriod)
    .map(([, month]) => month);
  const paidUsd = sumOf(counted, (month) => month.paidUsd);
  const heldBalanceUsd =
    sumOf(counted, (month) => month.heldUsd) - sumOf(counted, (month) => month.disposedUsd);
  return {
    grossUsd: paidUsd + heldBalanceUsd + openGross,
    heldUsd: heldBalanceUsd + openHeld,
    netUsd: paidUsd + openNet,
    distributedUsd: sumOf([...paystubs.months.values()], (month) => month.distributedUsd),
    isPartial:
      hasSatelliteGap(paystubs) ||
      hasUncoveredMonth(
        [...paystubs.months.keys()],
        previousComplete || previous !== undefined,
        now,
      ),
  };
}

/**
 * True when a month from the newest paystub month to the previous month is covered neither by a
 * paystub nor by the estimate (which covers the previous month when [previousCovered]).
 * `YYYY-MM` strings compare in calendar order.
 */
function hasUncoveredMonth(periods: string[], previousCovered: boolean, now: Date): boolean {
  const months = periods.filter((period) => /^\d{4}-\d{2}$/.test(period));
  if (months.length === 0) {
    return false;
  }
  const newest = months.reduce((latest, period) => (period > latest ? period : latest));
  // Two months back and earlier only paystubs can cover.
  return newest < paystubPeriod(now.getUTCFullYear(), now.getUTCMonth() - 2) || !previousCovered;
}

/** Start of the UTC day of [nowMs]. */
export function utcDayStart(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** ISO-8601 UTC without milliseconds when they are zero: `2026-10-24T00:00:00Z`. */
export function formatIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Figures of the newest day (today, still filling up), and its change computed from complete UTC
 * days only: the newest day before today against the one before it. Comparing today's partial day
 * with a full day would show a drop every morning with steady traffic. Entries must be sorted by
 * timestamp.
 */
export function computeBandwidthDailySummary(
  entries: BandwidthDailyEntry[],
  nowMs: number,
): StorjBandwidthStats | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const latest = entries[entries.length - 1];
  const todayStart = utcDayStart(nowMs);
  const completeDays = entries.filter((entry) => entry.timestamp < todayStart);
  const day = completeDays[completeDays.length - 1];
  const dayBefore = completeDays[completeDays.length - 2];
  const hasChange = day !== undefined && dayBefore !== undefined;

  return {
    totalBytes: latest.totalBytes,
    ingressBytes: latest.ingressBytes,
    egressBytes: latest.egressBytes,
    repairIngressBytes: latest.repairIngressBytes,
    repairEgressBytes: latest.repairEgressBytes,
    repairBytes: latest.repairBytes,
    auditBytes: latest.auditBytes,
    changeTotalBytes: hasChange ? day.totalBytes - dayBefore.totalBytes : undefined,
    changeIngressBytes: hasChange ? day.ingressBytes - dayBefore.ingressBytes : undefined,
    changeEgressBytes: hasChange ? day.egressBytes - dayBefore.egressBytes : undefined,
    changeRepairBytes: hasChange ? day.repairBytes - dayBefore.repairBytes : undefined,
    changeAuditBytes: hasChange ? day.auditBytes - dayBefore.auditBytes : undefined,
    changeSampleHours: hasChange
      ? Math.max(Math.round(((day.timestamp - dayBefore.timestamp) / MS_PER_HOUR) * 10) / 10, 0)
      : undefined,
    changeDayStart: hasChange ? formatIsoUtc(day.timestamp) : undefined,
  };
}
