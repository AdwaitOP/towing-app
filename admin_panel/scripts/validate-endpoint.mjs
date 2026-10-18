/**
 * Shared Endpoint & Project Boundary Validator (Section 4 & 5, Defect D4)
 *
 * Strict Fail-Closed Checks:
 * - Suppresses ancillary Google Cloud metadata detection in emulator-only tooling
 * - Rejects missing environment variables
 * - Rejects any userinfo (@), paths, queries, fragments or whitespace
 * - Strictly enforces loopback host (127.0.0.1 or localhost)
 * - Strictly enforces numeric port in range [1, 65535]
 * - Strictly validates against Node URL parser to ensure no Admin SDK HTTP escape
 * - Strictly rejects unexpected Firebase project IDs
 */

// Suppress ancillary Google Cloud instance metadata detection attempts (D4, Priority 3)
process.env.METADATA_SERVER_DETECTION = 'none';

export const EXPECTED_PROJECT_ID = 'demo-towmitra-admin';


export function validateEmulatorHost(varName, value, expectedPort = null) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    console.error(`\x1b[31m[FATAL] Missing required environment variable ${varName}.\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Missing required environment variable ${varName}.`);
  }

  const trimmed = value.trim();

  // Reject userinfo, slashes, query, fragment, control characters
  if (
    trimmed.includes('@') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    /\s/.test(trimmed)
  ) {
    console.error(`\x1b[31m[FATAL] Disallowed characters in ${varName}: "${trimmed}". Host cannot contain userinfo (@), path, query, or whitespace.\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Disallowed characters in ${varName}: "${trimmed}".`);
  }

  const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(trimmed);
  if (!match) {
    console.error(`\x1b[31m[FATAL] Invalid host:port format for ${varName}: "${trimmed}". Expected "<host>:<port>".\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Invalid host:port format for ${varName}: "${trimmed}".`);
  }

  const host = match[1].toLowerCase();
  const portStr = match[2];
  const port = parseInt(portStr, 10);

  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`\x1b[31m[FATAL] Non-loopback host in ${varName}: "${host}". Must strictly be "127.0.0.1" or "localhost".\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Non-loopback host in ${varName}: "${host}".`);
  }

  if (isNaN(port) || port < 1 || port > 65535 || String(port) !== portStr) {
    console.error(`\x1b[31m[FATAL] Invalid port in ${varName}: "${portStr}". Must be an integer between 1 and 65535.\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Invalid port in ${varName}: "${portStr}".`);
  }

  if (expectedPort !== null && port !== expectedPort) {
    console.error(`\x1b[31m[FATAL] Unexpected port in ${varName}: ${port}. Expected ${expectedPort}.\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] Unexpected port in ${varName}: ${port}. Expected ${expectedPort}.`);
  }

  // URL parser cross-verification
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (parsed.username || parsed.password) {
      console.error(`\x1b[31m[FATAL] Userinfo detected in ${varName}.\x1b[0m`);
      process.exit(1);
      throw new Error(`[FATAL] Userinfo detected in ${varName}.`);
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      console.error(`\x1b[31m[FATAL] Parsed hostname in ${varName} is non-loopback: "${parsed.hostname}".\x1b[0m`);
      process.exit(1);
      throw new Error(`[FATAL] Parsed hostname in ${varName} is non-loopback.`);
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      console.error(`\x1b[31m[FATAL] Path, query or hash detected in ${varName}.\x1b[0m`);
      process.exit(1);
      throw new Error(`[FATAL] Path, query or hash detected in ${varName}.`);
    }
    if (parseInt(parsed.port, 10) !== port) {
      console.error(`\x1b[31m[FATAL] Parsed port mismatch in ${varName}.\x1b[0m`);
      process.exit(1);
      throw new Error(`[FATAL] Parsed port mismatch in ${varName}.`);
    }
  } catch (err) {
    console.error(`\x1b[31m[FATAL] URL verification failed for ${varName}: ${err.message}\x1b[0m`);
    process.exit(1);
    throw new Error(`[FATAL] URL verification failed for ${varName}: ${err.message}`);
  }

  return { host, port, value: `${host}:${port}` };
}

export function validateProject(projectId) {
  if (!projectId || typeof projectId !== 'string' || projectId.trim() !== EXPECTED_PROJECT_ID) {
    console.error(`\x1b[31m[FATAL] Target project ID "${projectId}" is not permitted.\x1b[0m`);
    console.error(`Must strictly be "${EXPECTED_PROJECT_ID}". Live/production mode is forbidden.`);
    process.exit(1);
    throw new Error(`[FATAL] Target project ID "${projectId}" is not permitted.`);
  }
  return EXPECTED_PROJECT_ID;
}
