import type { MetricFormat } from '../types';

/**
 * Display formatting.
 *
 * Figures are held in absolute rupees end to end; the compaction to lakhs and
 * crores happens only here, at the point of display, so no rounding ever
 * reaches a calculation.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function currencySymbol(code: string | undefined): string {
  return CURRENCY_SYMBOLS[code ?? 'INR'] ?? '';
}

/**
 * Compact money in the Indian scale when the currency is INR, and in the
 * international scale otherwise - a reader of a Schedule III filing expects
 * crores, not millions.
 */
export function formatMoney(value: number | null, currency = 'INR'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const symbol = currencySymbol(currency);
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (currency === 'INR') {
    if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)} L`;
    return `${sign}${symbol}${Math.round(abs).toLocaleString('en-IN')}`;
  }
  if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${symbol}${Math.round(abs).toLocaleString('en-US')}`;
}

/** The full figure, for tooltips and the audit trail. */
export function formatExact(value: number | null, currency = 'INR'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${currencySymbol(currency)}${value.toLocaleString(locale, {
    maximumFractionDigits: 2,
  })}`;
}

export function formatMetric(
  value: number | null,
  format: MetricFormat,
  currency = 'INR',
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency':
      return formatMoney(value, currency);
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'times':
      return `${value.toFixed(2)}×`;
    case 'days':
      return `${Math.round(value)} days`;
    case 'ratio':
    default:
      return value.toFixed(2);
  }
}

export function formatChange(
  change: number | null,
  changePct: number | null,
  format: MetricFormat,
  currency = 'INR',
): string | null {
  if (change === null) return null;
  const sign = change > 0 ? '+' : '';
  if (format === 'currency') {
    const pct = changePct !== null ? ` (${sign}${(changePct * 100).toFixed(1)}%)` : '';
    return `${sign}${formatMoney(change, currency)}${pct}`;
  }
  if (format === 'percent') return `${sign}${(change * 100).toFixed(1)} pts`;
  if (changePct !== null) return `${sign}${(changePct * 100).toFixed(1)}%`;
  return `${sign}${change.toFixed(2)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
