import { describe, it, expect } from 'vitest';
import { evaluateAdminClaim } from '../adminAuthorization';

describe('evaluateAdminClaim (Strict Boolean Semantics)', () => {
  it('returns true when claims.admin is boolean true', () => {
    expect(evaluateAdminClaim({ admin: true })).toBe(true);
  });

  it('returns true when claims.admin is true alongside other claims', () => {
    expect(evaluateAdminClaim({ admin: true, role: 'co-owner', beta: true })).toBe(true);
  });

  it('rejects when claims.admin is boolean false', () => {
    expect(evaluateAdminClaim({ admin: false })).toBe(false);
  });

  it('rejects string "true" (must not coerce strings)', () => {
    expect(evaluateAdminClaim({ admin: 'true' })).toBe(false);
  });

  it('rejects number 1 (must not coerce truthy numbers)', () => {
    expect(evaluateAdminClaim({ admin: 1 })).toBe(false);
  });

  it('rejects objects or arrays (must not coerce truthy objects)', () => {
    expect(evaluateAdminClaim({ admin: {} })).toBe(false);
    expect(evaluateAdminClaim({ admin: [] })).toBe(false);
  });

  it('rejects null, undefined, or missing admin claim', () => {
    expect(evaluateAdminClaim({ admin: null })).toBe(false);
    expect(evaluateAdminClaim({ admin: undefined })).toBe(false);
    expect(evaluateAdminClaim({})).toBe(false);
    expect(evaluateAdminClaim(null)).toBe(false);
    expect(evaluateAdminClaim(undefined)).toBe(false);
  });
});
