/**
 * Maps requestedTruckType to fareCalculator serviceType.
 */
function getServiceType(requestedTruckType) {
  if (requestedTruckType === 'flatbed') {
    return 'flatbed';
  } else if (requestedTruckType === 'pulling') {
    return 'standard';
  }
  throw new Error(`Invalid requestedTruckType: ${requestedTruckType}`);
}

module.exports = { getServiceType };
