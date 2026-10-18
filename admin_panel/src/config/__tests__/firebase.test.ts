import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateEmulatorEnvironment, FatalConfigurationError } from '../firebase';

describe('validateEmulatorEnvironment (Fail-Closed Security Checks)', () => {

  beforeEach(() => {
    vi.stubEnv('VITE_USE_FIREBASE_EMULATOR', 'true');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-towmitra-admin');
    vi.stubEnv('VITE_FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099');
    vi.stubEnv('VITE_FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080');
    vi.stubEnv('VITE_FUNCTIONS_EMULATOR_HOST', '127.0.0.1:5001');
    vi.stubEnv('VITE_STORAGE_EMULATOR_HOST', '127.0.0.1:9199');
    vi.stubEnv('VITE_FUNCTIONS_REGION', 'asia-south1');
  });

  it('passes when strictly configured with demo-towmitra-admin and loopback emulators', () => {
    const config = validateEmulatorEnvironment();
    expect(config.projectId).toBe('demo-towmitra-admin');
    expect(config.authHost.hostname).toBe('127.0.0.1');
    expect(config.authHost.port).toBe(9099);
    expect(config.firestoreHost.port).toBe(8080);
    expect(config.region).toBe('asia-south1');
  });

  it('rejects unexpected project IDs (e.g. production towmitra)', () => {
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'towmitra-production');
    expect(() => validateEmulatorEnvironment()).toThrow(FatalConfigurationError);
    expect(() => validateEmulatorEnvironment()).toThrow(/Unexpected Firebase project ID/);
  });

  it('rejects when VITE_USE_FIREBASE_EMULATOR is false or missing', () => {
    vi.stubEnv('VITE_USE_FIREBASE_EMULATOR', 'false');
    expect(() => validateEmulatorEnvironment()).toThrow(FatalConfigurationError);
    expect(() => validateEmulatorEnvironment()).toThrow(/VITE_USE_FIREBASE_EMULATOR must be set to "true"/);
  });

  it('rejects non-loopback host for Auth emulator (e.g. external network or staging domain)', () => {
    vi.stubEnv('VITE_FIREBASE_AUTH_EMULATOR_HOST', '192.168.1.50:9099');
    expect(() => validateEmulatorEnvironment()).toThrow(FatalConfigurationError);
    expect(() => validateEmulatorEnvironment()).toThrow(/Non-loopback emulator host detected for Auth/);
  });

  it('rejects non-loopback host for Firestore emulator', () => {
    vi.stubEnv('VITE_FIRESTORE_EMULATOR_HOST', 'firestore.towmitra.in:8080');
    expect(() => validateEmulatorEnvironment()).toThrow(FatalConfigurationError);
    expect(() => validateEmulatorEnvironment()).toThrow(/Non-loopback emulator host detected for Firestore/);
  });

  it('rejects unexpected backend functions region', () => {
    vi.stubEnv('VITE_FUNCTIONS_REGION', 'us-central1');
    expect(() => validateEmulatorEnvironment()).toThrow(FatalConfigurationError);
    expect(() => validateEmulatorEnvironment()).toThrow(/Unexpected backend functions region/);
  });

  it('allows localhost as an authorized loopback hostname', () => {
    vi.stubEnv('VITE_FIREBASE_AUTH_EMULATOR_HOST', 'localhost:9099');
    const config = validateEmulatorEnvironment();
    expect(config.authHost.hostname).toBe('localhost');
  });
});
