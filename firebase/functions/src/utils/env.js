'use strict';

function requireEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`Missing required configuration: ${name}`);
    error.code = 'CONFIGURATION_ERROR';
    throw error;
  }
  return value.trim();
}

module.exports = { requireEnv };
