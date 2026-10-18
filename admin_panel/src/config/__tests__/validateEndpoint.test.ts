import { describe, it, expect, vi } from 'vitest';
import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from '../../../scripts/validate-endpoint.mjs';

describe('validate-endpoint.mjs Boundary Hardening (D4)', () => {
  it('allows valid loopback host and port', () => {
    const result1 = validateEmulatorHost('AUTH', '127.0.0.1:9099');
    expect(result1.host).toBe('127.0.0.1');
    expect(result1.port).toBe(9099);

    const result2 = validateEmulatorHost('FIRESTORE', 'localhost:8080');
    expect(result2.host).toBe('localhost');
    expect(result2.port).toBe(8080);
  });

  it('rejects external-host URL injection (@attacker.invalid)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:9099@attacker.invalid')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects paths, queries, fragments or protocol prefixes', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('AUTH', 'http://127.0.0.1:9099')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:9099/v1/projects')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:9099?probe=true')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects non-loopback hostnames', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('AUTH', '192.168.1.100:9099')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('AUTH', 'towmitra.in:9099')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects invalid or out-of-range ports', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:0')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:70000')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:abc')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('enforces expected port when provided', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('AUTH', '127.0.0.1:8080', 9099)).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('validates project ID strictly against demo-towmitra-admin', () => {
    expect(validateProject(EXPECTED_PROJECT_ID)).toBe(EXPECTED_PROJECT_ID);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateProject('towmitra-prod')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateProject('')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects missing or undefined host values (D4)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', undefined)).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', '')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(() => validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', '   ')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects missing or undefined project ID (D4)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    expect(() => validateProject(undefined)).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
