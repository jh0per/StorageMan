/**
 * A number from a node payload: finite numbers and numeric strings (hastings and some Storj
 * fields come as strings). Booleans, objects, arrays, null, blank and non-numeric strings are not
 * numbers, so they read as missing instead of becoming 1, 0 or NaN.
 */
export function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return undefined;
    }
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

/** Storj estimated-payout amounts are in cents. */
export function centsToDollars(value: unknown): number {
  return (toNumberOrUndefined(value) ?? 0) / 100;
}

/** Storj paystub amounts are in micro-USD. */
export function microDollarsToDollars(value: unknown): number {
  return (toNumberOrUndefined(value) ?? 0) / 1_000_000;
}

/** Hastings (1 SC = 1e24 H, usually a JSON string) to SC; undefined when absent or not a number. */
export function hastingsToSiacoinsOrUndefined(value: unknown): number | undefined {
  const numeric = toNumberOrUndefined(value);
  return numeric === undefined ? undefined : numeric / 1e24;
}

export function hastingsToSiacoins(value: unknown): number {
  return hastingsToSiacoinsOrUndefined(value) ?? 0;
}
