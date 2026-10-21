'use strict';

require('../config/adminInit');
const { onCall } = require('firebase-functions/v2/https');
const { createDecisionManager } = require('./driverVerificationDecision');

function createRejectDriverCallable({ manager = null } = {}) {
  let defaultManager = manager;
  function getManager() {
    if (!defaultManager) {
      defaultManager = createDecisionManager();
    }
    return defaultManager;
  }

  const handler = async (request) => {
    const mgr = getManager();
    return await mgr.executeDecision({
      operation: 'adminRejectDriver',
      request,
    });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const adminRejectDriver = createRejectDriverCallable();

module.exports = {
  createRejectDriverCallable,
  adminRejectDriver,
};
