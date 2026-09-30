/**
 * The new-api family of relays reports balances, consumption and check-in
 * awards in raw quota units, while the dashboard stores every money column in
 * dollars. Each fork mints a different number of quota units per dollar, so the
 * conversion factor has to be declared per adapter rather than guessed from the
 * magnitude of a single value (a small quota award and a dollar award can look
 * identical).
 */

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Scales a raw quota amount to dollars with the adapter's quota-per-unit. */
export function quotaToUsd(quota: unknown, quotaPerUnit: number): number {
  const numeric = typeof quota === 'number' ? quota : Number(quota);
  if (!Number.isFinite(numeric) || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    return 0;
  }
  return roundUsd(numeric / quotaPerUnit);
}

/**
 * Check-in endpoints answer with the awarded amount in raw quota units, so it
 * must be scaled before it reaches the dollar-based reward column. Values that
 * are not numeric are handed back untouched for the shared reward parser to
 * digest.
 */
export function normalizeCheckinReward(raw: unknown, quotaPerUnit: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return String(raw);
  return String(quotaToUsd(numeric, quotaPerUnit));
}
