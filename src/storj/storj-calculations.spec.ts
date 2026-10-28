import {
  BandwidthDailyEntry,
  computeBandwidthDailySummary,
  computeLifetimeSnapshot,
  previousPaystubPeriod,
  sumPaystubs,
} from './storj-calculations';

const NOW = new Date('2026-10-25T12:00:00Z');
// Estimated payout, as the service converts it from cents.
const CURRENT = { grossUsd: 10.5, heldUsd: 2.1, netUsd: 8.4 };
const PREVIOUS = { grossUsd: 15, heldUsd: 3, netUsd: 12 };

/**
 * One storagenode `payouts.PayStub` (micro-USD), shaped like the real ones: owed = earned - held +
 * disposed, and paid == owed unless the satellites hold the payment back (paid 0).
 */
function paystub(
  period: string,
  amounts: { held: number; owed: number; disposed: number; paid: number; distributed: number },
  satelliteId = 'us1',
) {
  return { satelliteId, period, created: `${period}-05T10:00:00Z`, ...amounts };
}

// Earned 6.00, held 3.00: owed 3.00, paid and distributed.
const AUGUST_US1 = paystub('2026-08', {
  held: 3_000_000,
  owed: 3_000_000,
  disposed: 0,
  paid: 3_000_000,
  distributed: 3_000_000,
});
// Earned 4.50, held 0.50, held amount returned 2.00: owed 6.00, but the satellites hold the payment
// back (paid 0, as on the real 2026-07 paystubs: Storj's Chapter 11 court hold). The 6.20
// distributed is the next month's prepayment, as on those paystubs.
const SEPTEMBER_US1 = paystub('2026-09', {
  held: 500_000,
  owed: 6_000_000,
  disposed: 2_000_000,
  paid: 0,
  distributed: 6_200_000,
});
// Earned 1.25, nothing held: owed 1.25, paid and distributed.
const SEPTEMBER_EU1 = paystub(
  '2026-09',
  { held: 0, owed: 1_250_000, disposed: 0, paid: 1_250_000, distributed: 1_250_000 },
  'eu1',
);
// Earned 0.50, nothing held: owed 0.50, paid and distributed.
const AUGUST_EU1 = paystub(
  '2026-08',
  { held: 0, owed: 500_000, disposed: 0, paid: 500_000, distributed: 500_000 },
  'eu1',
);

describe('sumPaystubs', () => {
  it('sums paid, held, disposed and distributed in USD by period with its satellites', () => {
    const totals = sumPaystubs([AUGUST_US1, SEPTEMBER_US1, SEPTEMBER_EU1, 'junk', null]);

    expect([...totals.months.keys()]).toEqual(['2026-08', '2026-09']);
    const september = totals.months.get('2026-09');
    expect(september?.paidUsd).toBeCloseTo(1.25, 9);
    expect(september?.heldUsd).toBeCloseTo(0.5, 9);
    expect(september?.disposedUsd).toBeCloseTo(2, 9);
    expect(september?.distributedUsd).toBeCloseTo(7.45, 9);
    expect([...(september?.satellites ?? [])]).toEqual(['us1', 'eu1']);
    expect(totals.months.get('2026-08')?.paidUsd).toBeCloseTo(3, 9);
  });

  it('counts nothing paid for a month held back, whatever it owed', () => {
    expect(sumPaystubs([SEPTEMBER_US1]).months.get('2026-09')?.paidUsd).toBe(0);
  });
});

describe('computeLifetimeSnapshot', () => {
  it('counts paid and the held balance once and keeps distributed apart', () => {
    const total = computeLifetimeSnapshot({
      current: CURRENT,
      previous: PREVIOUS,
      paystubs: sumPaystubs([AUGUST_US1, SEPTEMBER_US1, SEPTEMBER_EU1]),
      now: NOW,
    });

    // Paystubs: paid 4.25, held 3.50, disposed 2.00, distributed 10.45. September has
    // paystubs, so only the current month's estimate is added (gross 10.50, held 2.10, net 8.40).
    expect(total.netUsd).toBeCloseTo(4.25 + 8.4, 9);
    expect(total.heldUsd).toBeCloseTo(3.5 - 2 + 2.1, 9);
    expect(total.grossUsd).toBeCloseTo(total.netUsd + total.heldUsd, 9);
    // Gross is the storagenode dashboard's paid + held - disposed, plus the open month.
    expect(total.grossUsd).toBeCloseTo(4.25 + 1.5 + 10.5, 9);
    expect(total.distributedUsd).toBeCloseTo(10.45, 9);
    expect(total.isPartial).toBe(false);
  });

  it('counts a month held back once it is paid', () => {
    // The hold lifted: the same September paystub with its owed 6.00 recorded as paid.
    const released = { ...SEPTEMBER_US1, paid: 6_000_000 };
    const lifetime = (stubs: unknown[]) =>
      computeLifetimeSnapshot({ current: CURRENT, paystubs: sumPaystubs(stubs), now: NOW });
    const heldBack = lifetime([AUGUST_US1, SEPTEMBER_US1]);
    const paid = lifetime([AUGUST_US1, released]);

    // August paid 3 and held 3, September held 0.50 and returned 2.00, plus October so far.
    expect(heldBack.netUsd).toBeCloseTo(3 + 8.4, 9);
    expect(heldBack.grossUsd).toBeCloseTo(3 + 1.5 + 10.5, 9);
    expect(paid.netUsd).toBeCloseTo(3 + 6 + 8.4, 9);
    expect(paid.grossUsd).toBeCloseTo(3 + 6 + 1.5 + 10.5, 9);
    expect(paid.heldUsd).toBeCloseTo(heldBack.heldUsd, 9);
    // Distributed (here the next month's prepayment) is never added to net or gross.
    expect(heldBack.distributedUsd).toBeCloseTo(3 + 6.2, 9);
  });

  it('counts the previous month from its estimate until its paystubs exist', () => {
    const total = computeLifetimeSnapshot({
      current: CURRENT,
      previous: PREVIOUS,
      paystubs: sumPaystubs([AUGUST_US1]),
      now: NOW,
    });

    expect(total.netUsd).toBeCloseTo(3 + 12 + 8.4, 9);
    expect(total.heldUsd).toBeCloseTo(3 + 3 + 2.1, 9);
    expect(total.grossUsd).toBeCloseTo(6 + 15 + 10.5, 9);
    expect(total.distributedUsd).toBeCloseTo(3, 9);
    expect(total.isPartial).toBe(false);
  });

  it('counts the previous month from its estimate until every satellite has its paystub', () => {
    // storagenode fetches the previous month's paystubs one satellite at a time, and the
    // satellites publish them hours apart: us1's September paystub is in, eu1's is not yet.
    const lifetime = (stubs: unknown[]) =>
      computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs(stubs),
        now: NOW,
      });
    const someIn = lifetime([AUGUST_US1, AUGUST_EU1, SEPTEMBER_US1]);
    const allIn = lifetime([AUGUST_US1, AUGUST_EU1, SEPTEMBER_US1, SEPTEMBER_EU1]);

    // August (paid 3.50, held 3) + the September estimate (gross 15, held 3, net 12) in place of
    // us1's September paystub + October so far.
    expect(someIn.netUsd).toBeCloseTo(3.5 + 12 + 8.4, 9);
    expect(someIn.heldUsd).toBeCloseTo(3 + 3 + 2.1, 9);
    expect(someIn.grossUsd).toBeCloseTo(6.5 + 15 + 10.5, 9);
    expect(someIn.isPartial).toBe(false);
    // Distributed is what was transferred, us1's September transfer included.
    expect(someIn.distributedUsd).toBeCloseTo(3.5 + 6.2, 9);
    // Once both are in, the September paystubs replace the estimate.
    expect(allIn.netUsd).toBeCloseTo(3.5 + 1.25 + 8.4, 9);
    expect(allIn.heldUsd).toBeCloseTo(3 + 0.5 - 2 + 2.1, 9);
    expect(allIn.isPartial).toBe(false);
  });

  it('marks an incomplete previous month partial when the estimate has none', () => {
    const total = computeLifetimeSnapshot({
      current: CURRENT,
      paystubs: sumPaystubs([AUGUST_US1, AUGUST_EU1, SEPTEMBER_US1]),
      now: NOW,
    });

    expect(total.isPartial).toBe(true);
    // What is in still counts: August, us1's September (paid 0, held 0.50, returned 2.00) and
    // October so far.
    expect(total.netUsd).toBeCloseTo(3.5 + 0 + 8.4, 9);
    expect(total.heldUsd).toBeCloseTo(3 + 0.5 - 2 + 2.1, 9);
  });

  // storagenode dates its previous-month estimate now.AddDate(0, -1, 0), which Go normalises:
  // March 31 minus a month is "February 31", i.e. March 3, so previousMonth is March again.
  it('never counts a previous month estimate that is the current month', () => {
    const counted: Array<[string, boolean]> = [
      ['2026-03-28T23:59:59Z', true],
      ['2026-03-29T00:00:00Z', false],
      ['2026-03-31T12:00:00Z', false],
      ['2028-03-29T12:00:00Z', true],
      ['2028-03-30T12:00:00Z', false],
      ['2026-05-30T12:00:00Z', true],
      ['2026-05-31T12:00:00Z', false],
      ['2026-07-31T12:00:00Z', false],
      ['2026-08-31T12:00:00Z', true],
      ['2026-10-31T12:00:00Z', false],
      ['2026-12-31T12:00:00Z', false],
      ['2026-01-31T12:00:00Z', true],
    ];

    for (const [date, previousCounted] of counted) {
      // A new node: no paystubs, so the open months are the whole total.
      const total = computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs([]),
        now: new Date(date),
      });
      expect({
        date,
        netUsd: Math.round(total.netUsd * 100) / 100,
        isPartial: total.isPartial,
      }).toEqual({
        date,
        netUsd: previousCounted ? 20.4 : 8.4,
        isPartial: false,
      });
    }
  });

  it('marks an incomplete previous month partial when its estimate is the current month', () => {
    const MARCH_LAST = new Date('2026-03-31T12:00:00Z');
    const stub = (period: string, paid: number, satelliteId: string) =>
      paystub(period, { held: 0, owed: paid, disposed: 0, paid, distributed: 0 }, satelliteId);
    const lifetime = (stubs: unknown[]) =>
      computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs(stubs),
        now: MARCH_LAST,
      });
    const january = [stub('2026-01', 1_000_000, 'us1'), stub('2026-01', 500_000, 'eu1')];

    const someIn = lifetime([...january, stub('2026-02', 2_000_000, 'us1')]);
    const allIn = lifetime([
      ...january,
      stub('2026-02', 2_000_000, 'us1'),
      stub('2026-02', 250_000, 'eu1'),
    ]);

    // January, us1's February paystub and March so far; the "previous month" estimate (March
    // again) is left out instead of standing in for February.
    expect(someIn.netUsd).toBeCloseTo(1.5 + 2 + 8.4, 9);
    expect(someIn.isPartial).toBe(true);
    expect(allIn.netUsd).toBeCloseTo(1.5 + 2.25 + 8.4, 9);
    expect(allIn.isPartial).toBe(false);
  });

  it('marks the total partial when a satellite misses a month between its first and newest paystub', () => {
    const stub = (period: string, satelliteId: string) =>
      paystub(
        period,
        { held: 0, owed: 1_000_000, disposed: 0, paid: 1_000_000, distributed: 0 },
        satelliteId,
      );
    const lifetime = (stubs: unknown[]) =>
      computeLifetimeSnapshot({
        current: CURRENT,
        paystubs: sumPaystubs(stubs),
        now: NOW,
      });

    // October 25: September is the previous month, August two months back.
    const julyMissing = lifetime([
      stub('2026-06', 'us1'),
      stub('2026-08', 'us1'),
      stub('2026-09', 'us1'),
    ]);
    const missingForAll = lifetime(
      ['2026-06', '2026-08', '2026-09'].flatMap((period) => [
        stub(period, 'us1'),
        stub(period, 'eu1'),
      ]),
    );
    // Not gaps: eu1 joined in August, ap1 has no paystub after July (left, or not fetched).
    const joinedAndLeft = lifetime([
      ...['2026-06', '2026-07', '2026-08', '2026-09'].map((period) => stub(period, 'us1')),
      ...['2026-08', '2026-09'].map((period) => stub(period, 'eu1')),
      ...['2026-06', '2026-07'].map((period) => stub(period, 'ap1')),
    ]);

    expect(julyMissing.isPartial).toBe(true);
    // What is in still counts: three paystubs and October so far.
    expect(julyMissing.netUsd).toBeCloseTo(3 + 8.4, 9);
    expect(missingForAll.isPartial).toBe(true);
    expect(joinedAndLeft.isPartial).toBe(false);
  });

  it('a new node without paystubs counts its open months', () => {
    const total = computeLifetimeSnapshot({
      current: CURRENT,
      previous: PREVIOUS,
      paystubs: sumPaystubs([]),
      now: NOW,
    });

    expect(total.netUsd).toBeCloseTo(12 + 8.4, 9);
    expect(total.grossUsd).toBeCloseTo(15 + 10.5, 9);
    expect(total.isPartial).toBe(false);
  });

  it('marks the total partial when the paystub history is missing', () => {
    const total = computeLifetimeSnapshot({ current: CURRENT, previous: PREVIOUS, now: NOW });

    expect(total.isPartial).toBe(true);
    expect(total.netUsd).toBeCloseTo(12 + 8.4, 9);
    expect(total.heldUsd).toBeCloseTo(3 + 2.1, 9);
    expect(total.grossUsd).toBeCloseTo(15 + 10.5, 9);
    expect(total.distributedUsd).toBe(0);
  });

  // The real 2026-07 paystubs appeared on 2026-09-01 around 10:00 UTC. Before that the estimate
  // covered August and September only, so July was in neither.
  describe('a month in neither the paystubs nor the estimate', () => {
    const SEPTEMBER_FIRST = new Date('2026-09-01T05:00:00Z');
    const JUNE = paystub('2026-06', {
      held: 0,
      owed: 2_000_000,
      disposed: 0,
      paid: 2_000_000,
      distributed: 2_000_000,
    });
    const JULY = paystub('2026-07', {
      held: 0,
      owed: 1_000_000,
      disposed: 0,
      paid: 0,
      distributed: 1_000_000,
    });

    it('marks the total partial while the paystubs of two months back are not out yet', () => {
      const total = computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs([JUNE]),
        now: SEPTEMBER_FIRST,
      });

      expect(total.isPartial).toBe(true);
      // What is known still counts: June + the August estimate + September so far.
      expect(total.netUsd).toBeCloseTo(2 + 12 + 8.4, 9);
    });

    it('is complete once those paystubs exist', () => {
      const total = computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs([JUNE, JULY]),
        now: SEPTEMBER_FIRST,
      });

      expect(total.isPartial).toBe(false);
      // July's payment is held back (paid 0), so it adds nothing to net yet.
      expect(total.netUsd).toBeCloseTo(2 + 12 + 8.4, 9);
    });

    it('counts the previous month as missing when the estimate has none', () => {
      const withoutPrevious = (stubs: unknown[]) =>
        computeLifetimeSnapshot({
          current: CURRENT,
          paystubs: sumPaystubs(stubs),
          now: SEPTEMBER_FIRST,
        });

      expect(withoutPrevious([JUNE, JULY]).isPartial).toBe(true);
      expect(withoutPrevious([JUNE, JULY, AUGUST_US1]).isPartial).toBe(false);
    });

    it('works over the year boundary', () => {
      const total = computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs([
          paystub('2025-10', { held: 0, owed: 1, disposed: 0, paid: 1, distributed: 0 }),
        ]),
        now: new Date('2026-01-01T05:00:00Z'),
      });
      const complete = computeLifetimeSnapshot({
        current: CURRENT,
        previous: PREVIOUS,
        paystubs: sumPaystubs([
          paystub('2025-11', { held: 0, owed: 1, disposed: 0, paid: 1, distributed: 0 }),
        ]),
        now: new Date('2026-01-01T05:00:00Z'),
      });

      expect(total.isPartial).toBe(true);
      expect(complete.isPartial).toBe(false);
    });
  });

  it('the previous period wraps over the year', () => {
    expect(previousPaystubPeriod(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
    expect(previousPaystubPeriod(NOW)).toBe('2026-09');
  });
});

describe('computeBandwidthDailySummary', () => {
  function day(
    date: string,
    egressUsage: number,
    repair: number,
    audit: number,
  ): BandwidthDailyEntry {
    const ingress = 7_000_000_000 + 90_000_000_000;
    const egress = egressUsage + repair + audit;
    return {
      timestamp: Date.parse(`${date}T00:00:00Z`),
      totalBytes: ingress + egress,
      ingressBytes: ingress,
      egressBytes: egress,
      repairIngressBytes: 7_000_000_000,
      repairEgressBytes: repair,
      repairBytes: 7_000_000_000 + repair,
      auditBytes: audit,
    };
  }

  const dayBefore = day('2026-10-23', 800_000_000_000, 2_000_000_000, 1_000_000_000);
  const yesterday = day('2026-10-24', 900_000_000_000, 1, 1);
  const today = day('2026-10-25', 100_000_000_000, 50_000_000_000, 1_000_000_000);

  it("reports today's figures and the change between the last two complete days", () => {
    const summary = computeBandwidthDailySummary([dayBefore, yesterday, today], NOW.getTime());

    // Today so far (partial day).
    expect(summary?.totalBytes).toBe(248_000_000_000);
    // Oct 24 against Oct 23, not today's partial day against Oct 24.
    expect(summary?.changeTotalBytes).toBe(97_000_000_002);
    expect(summary?.changeEgressBytes).toBe(97_000_000_002);
    expect(summary?.changeIngressBytes).toBe(0);
    expect(summary?.changeSampleHours).toBe(24);
    expect(summary?.changeDayStart).toBe('2026-10-24T00:00:00Z');
  });

  it('has no change without two complete days', () => {
    const summary = computeBandwidthDailySummary([yesterday, today], NOW.getTime());

    expect(summary?.totalBytes).toBe(248_000_000_000);
    expect(summary?.changeTotalBytes).toBeUndefined();
    expect(summary?.changeSampleHours).toBeUndefined();
    expect(summary?.changeDayStart).toBeUndefined();
  });

  it('has nothing to report without entries', () => {
    expect(computeBandwidthDailySummary([], NOW.getTime())).toBeUndefined();
  });
});
