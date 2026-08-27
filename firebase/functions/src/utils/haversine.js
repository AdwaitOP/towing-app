'use strict';

function normalizeCoordinates(coords, label = 'coordinates') {
  if (!coords || typeof coords !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  const lat = Number(coords.lat);
  const lng = Number(coords.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new TypeError(`${label} latitude and longitude must be finite numbers`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError(`${label} is outside valid latitude/longitude bounds`);
  }
  return { lat, lng };
}

function haversineDistance(coords1, coords2) {
  const from = normalizeCoordinates(coords1, 'pickupCoords');
  const to = normalizeCoordinates(coords2, 'destCoords');
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { normalizeCoordinates, haversineDistance };
