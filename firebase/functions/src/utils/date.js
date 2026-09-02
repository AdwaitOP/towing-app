'use strict';

const IST_TIME_ZONE = 'Asia/Kolkata';

function assertValidDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('A valid Date is required');
  }
}

function getIstHour(date = new Date()) {
  assertValidDate(date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    hour: '2-digit',
    hour12: false,
  });
  const hourPart = formatter.formatToParts(date).find(part => part.type === 'hour');
  if (!hourPart) throw new Error('Could not parse IST hour');
  return Number(hourPart.value) % 24;
}

function getIstDateString(date = new Date()) {
  assertValidDate(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function getIstMonthString(date = new Date()) {
  return getIstDateString(date).slice(0, 7);
}

module.exports = { IST_TIME_ZONE, getIstHour, getIstDateString, getIstMonthString };
