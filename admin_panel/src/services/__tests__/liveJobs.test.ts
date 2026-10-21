import { describe, it, expect } from 'vitest';
import {
  formatPaiseToRupees,
  maskPhoneNumber,
  DEFAULT_ACTIVE_JOB_STATES,
  PAGE_SIZE,
  QUERY_LIMIT,
} from '../liveJobs';

describe('liveJobs Service', () => {
  describe('formatPaiseToRupees (O3 / F10)', () => {
    it('formats valid integer paise to Indian Rupee strings', () => {
      // In node/browser en-IN locale currency formatting
      const zero = formatPaiseToRupees(0);
      expect(zero).toMatch(/0\.00/);

      const hundred = formatPaiseToRupees(100);
      expect(hundred).toMatch(/1\.00/);

      const oddPaise = formatPaiseToRupees(1255);
      expect(oddPaise).toMatch(/12\.55/);

      const large = formatPaiseToRupees(50000);
      expect(large).toMatch(/500\.00/);
    });

    it('safely handles undefined, null, NaN, and negative amounts', () => {
      expect(formatPaiseToRupees(undefined)).toBe('Unavailable');
      expect(formatPaiseToRupees(null as any)).toBe('Unavailable');
      expect(formatPaiseToRupees(NaN)).toBe('Unavailable');
      expect(formatPaiseToRupees(-500)).toBe('Unavailable');
      expect(formatPaiseToRupees(1.5 as any)).toBe('Unavailable');
    });
  });

  describe('maskPhoneNumber', () => {
    it('masks middle digits showing first 3 and last 3 characters', () => {
      expect(maskPhoneNumber('+919876543210')).toBe('+91****210');
      expect(maskPhoneNumber('9876543210')).toBe('987****210');
    });

    it('handles short or undefined numbers safely', () => {
      expect(maskPhoneNumber(undefined)).toBe('Unavailable');
      expect(maskPhoneNumber('')).toBe('Unavailable');
      expect(maskPhoneNumber('12345')).toBe('12345');
    });
  });

  describe('Query and State Contracts (F08)', () => {
    it('enforces exact live statuses allowlist', () => {
      expect(DEFAULT_ACTIVE_JOB_STATES).toEqual([
        'pending_offer',
        'offered',
        'accepted',
        'in_progress',
      ]);
    });

    it('excludes terminal states (completed, cancelled, refunded) from live statuses', () => {
      expect(DEFAULT_ACTIVE_JOB_STATES).not.toContain('completed');
      expect(DEFAULT_ACTIVE_JOB_STATES).not.toContain('cancelled');
      expect(DEFAULT_ACTIVE_JOB_STATES).not.toContain('refunded');
    });

    it('enforces page limit of 25 with query limit of 26', () => {
      expect(PAGE_SIZE).toBe(25);
      expect(QUERY_LIMIT).toBe(26);
    });
  });
});
