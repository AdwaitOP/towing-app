'use strict';
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');
const { registerSignedTopupWebhookCases } = require('./signedTopupWebhookCases');
registerSignedTopupWebhookCases(async () => ({ db: new FakeFirestore(), TimestampClass: FakeTimestamp }), 'Model');
