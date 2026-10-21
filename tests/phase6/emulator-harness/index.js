'use strict';

/**
 * Isolated Functions Emulator Harness for TowMitra Phase 6 M2.
 * Exports ONLY the two approved production M2 callables:
 * - adminApproveDriver
 * - adminRejectDriver
 *
 * It NEVER requires production src/index.js or initializes triggers/workers.
 */

require('../../../firebase/functions/src/config/adminInit');

const { adminApproveDriver } = require('../../../firebase/functions/src/admin/approveDriver');
const { adminRejectDriver } = require('../../../firebase/functions/src/admin/rejectDriver');

exports.adminApproveDriver = adminApproveDriver;
exports.adminRejectDriver = adminRejectDriver;
