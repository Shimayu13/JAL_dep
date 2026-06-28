const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AIRLINES,
  arrivalDayOffset,
  flightNumber,
  flightScope,
  isPeriodActive,
  normalizeTime,
  parseCsv,
} = require('../server');

assert.equal(AIRLINES.JAL.prefix, 'JL');
assert.equal(AIRLINES.ANA.prefix, 'NH');
assert.equal(AIRLINES.SKY.prefix, 'SKY');
assert.equal(flightNumber(['NH123', 'UA456'], 'NH'), 'NH123');
assert.equal(flightNumber(['JL123', 'AA456'], 'JL'), 'JL123');
assert.equal(flightScope('odpt.Airport:HND', 'odpt.Airport:CTS'), 'domestic');
assert.equal(flightScope('odpt.Airport:HND', 'odpt.Airport:JFK'), 'international');
assert.equal(arrivalDayOffset('23:00', '05:00'), 1);
assert.equal(arrivalDayOffset('08:00', '10:00'), 0);
assert.equal(arrivalDayOffset('10:20', '10:05', 'odpt.Airport:HND', 'odpt.Airport:IAD'), 0);
assert.equal(arrivalDayOffset('12:00', '15:00', 'odpt.Airport:HNL', 'odpt.Airport:HND'), 1);
assert.equal(arrivalDayOffset('23:00', '05:00', 'odpt.Airport:HND', 'odpt.Airport:FRA'), 1);
assert.equal(normalizeTime('6:45'), '06:45');
assert.equal(normalizeTime('16:10'), '16:10');
assert.equal(isPeriodActive('6/1~10/24', '2026-06-28'), true);
assert.equal(isPeriodActive('6/1~6/18', '2026-06-28'), false);
assert.equal(isPeriodActive('6/19�`10/24', '2026-06-28'), true);

const csv = fs.readFileSync(path.join(__dirname, '..', 'Skymark_timetable.csv'), 'utf8');
const rows = parseCsv(csv);
assert.equal(rows.length, 175);
assert.equal(rows[0].Flight, 'SKY703');
assert.equal(rows[0].Origin, 'HND');
assert.equal(rows.every((row) => row.Flight.startsWith('SKY')), true);

console.log('Server airline and day-offset tests passed');
