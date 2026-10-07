'use strict';

// Explicitly injected test fixture; never imported by production code.
function createFakeTopupProvider() {
  let sequence = 0;
  return {
    createOrder: async () => ({ id: `order_injected_${++sequence}`, keyId: 'rzp_injected_fixture' }),
  };
}

module.exports = { createFakeTopupProvider };
