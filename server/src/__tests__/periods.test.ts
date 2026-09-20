import { describe, expect, it } from 'vitest';
import { detectCurrency, detectUnitScale } from '../parse/periods.js';

describe('detectUnitScale', () => {
  it('reads the Indian scales', () => {
    expect(detectUnitScale('All figures in lakhs')).toEqual({ scale: 1e5, label: 'Lakh' });
    expect(detectUnitScale('Amounts in Rs. crores')).toEqual({ scale: 1e7, label: 'Crore' });
  });

  it('tolerates a currency word between "in" and the unit', () => {
    // "in USD thousands" and "in Rs. lakhs" are both common phrasings.
    expect(detectUnitScale('All amounts in USD thousands')).toEqual({
      scale: 1e3,
      label: 'Thousand',
    });
    expect(detectUnitScale('(Amounts in INR lakhs)')).toEqual({ scale: 1e5, label: 'Lakh' });
  });

  it('defaults to absolute figures', () => {
    expect(detectUnitScale('All amount in Indian Rupees,')).toEqual({
      scale: 1,
      label: 'Absolute',
    });
    expect(detectUnitScale('')).toEqual({ scale: 1, label: 'Absolute' });
  });
});

describe('detectCurrency', () => {
  it('reads the reporting currency from the header', () => {
    expect(detectCurrency('All amount in Indian Rupees')).toBe('INR');
    expect(detectCurrency('Amounts in USD thousands')).toBe('USD');
    expect(detectCurrency('Figures in EUR')).toBe('EUR');
  });

  it('falls back to INR when nothing says otherwise', () => {
    expect(detectCurrency('Balance Sheet')).toBe('INR');
  });
});
