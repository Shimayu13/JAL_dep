const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const element = {
  hidden: false,
  textContent: '',
  innerHTML: '',
  addEventListener() {},
  classList: { toggle() {} },
  setAttribute() {},
};

const context = {
  console,
  Intl,
  Date,
  Number,
  document: {
    body: { dataset: {} },
    querySelector: () => ({ ...element }),
    querySelectorAll: () => [],
  },
  fetch: () => new Promise(() => {}),
  setInterval: () => 0,
};

const appPath = path.join(__dirname, '..', 'public', 'app.js');
const source = `${fs.readFileSync(appPath, 'utf8')}\n;globalThis.__test = { state, searchable, selectAirline, timeTemplate, sortFlights, groupedRowsTemplate };`;
vm.runInNewContext(source, context, { filename: appPath });

const { state, searchable, selectAirline, timeTemplate, sortFlights, groupedRowsTemplate } = context.__test;
const flight = (id, date, from, to, time, aircraft, dayLabel, dayOffset = 0) => ({
  id, date, dayLabel, number: `JL${id}`,
  from: { code: from, name: from },
  to: { code: to, name: to },
  scheduledDepartureTime: time,
  scheduledArrivalTime: time,
  departureTime: time,
  arrivalTime: time,
  arrivalDayOffset: dayOffset,
  aircraft,
  status: 'scheduled',
  statusLabel: '定刻予定',
});

const flights = [
  flight('5', '2026-06-29', 'AAA', 'ZZZ', '06:00', '738', '明日'),
  flight('4', '2026-06-28', 'BBB', 'AAA', '07:00', '767', '本日'),
  flight('3', '2026-06-28', 'AAA', 'BBB', '12:00', '738', '本日'),
  flight('2', '2026-06-28', 'AAA', 'CCC', '08:00', '738', '本日'),
  flight('1', '2026-06-28', 'AAA', 'DDD', '10:00', '767', '本日'),
];

const hanedaDeparture = flight('6', '2026-06-28', 'HND', 'CTS', '09:00', '738', '本日');
const hanedaArrival = flight('7', '2026-06-28', 'ITM', 'HND', '10:00', '738', '本日');
state.searchTarget = 'from';
assert.match(searchable(hanedaDeparture), /hnd/);
assert.doesNotMatch(searchable(hanedaArrival), /hnd/);
state.searchTarget = 'to';
assert.doesNotMatch(searchable(hanedaDeparture), /hnd/);
assert.match(searchable(hanedaArrival), /hnd/);

assert.match(timeTemplate(null, '05:00', '05:00', 1), /05:00.*\(\+1\)/);

selectAirline('SKY');
assert.equal(state.airline, 'SKY');
assert.equal(context.document.body.dataset.airline, 'SKY');

state.sort = 'from';
assert.deepEqual(Array.from(sortFlights(flights), (item) => item.id), ['2', '1', '3', '4', '5']);

state.sort = 'to';
assert.deepEqual(Array.from(sortFlights(flights), (item) => item.id), ['4', '3', '2', '1', '5']);

state.sort = 'aircraft';
assert.deepEqual(Array.from(sortFlights(flights), (item) => item.id), ['2', '3', '4', '1', '5']);

const sameDayLate = flight('8', '2026-06-28', 'HND', 'CTS', '23:00', '738', '本日', 0);
const nextDayEarly = flight('9', '2026-06-28', 'HND', 'FUK', '05:00', '738', '本日', 1);
state.sort = 'arrival';
assert.deepEqual(Array.from(sortFlights([nextDayEarly, sameDayLate]), (item) => item.id), ['8', '9']);

state.activeTab = 'upcoming';
const grouped = groupedRowsTemplate(sortFlights(flights), flights);
assert.ok(grouped.indexOf('本日') < grouped.indexOf('明日'));
assert.match(grouped, /6月28日/);
assert.match(grouped, /6月29日/);

console.log('Frontend sorting tests passed');
