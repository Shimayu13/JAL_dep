const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.ODPT_ACCESS_TOKEN;
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_ROOT = 'https://api.odpt.org/api/v4';
const CACHE_TTL = 30_000;
let cache = { expiresAt: 0, data: null };

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

function jstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, item) => ({ ...acc, [item.type]: item.value }), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function addJstDays(dateString, amount) {
  const date = new Date(`${dateString}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + amount);
  return jstParts(date);
}

async function odpt(type, params = {}) {
  const url = new URL(`${API_ROOT}/odpt:${type}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('acl:consumerKey', TOKEN);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ODPT ${type}: HTTP ${response.status}`);
  return response.json();
}

function code(value) {
  return String(value || '').split(':').pop();
}

function flightNumber(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(String).find((item) => /^JL\d+/i.test(item)) || values[0] || '—';
}

function statusLabel(value) {
  return ({
    InAir: '飛行中', Departed: '出発済み', Cancelled: '欠航',
  })[code(value)] || '定刻予定';
}

function airportInfo(id, airports) {
  const airportCode = code(id);
  const item = airports.get(id);
  return {
    code: airportCode,
    name: item?.['odpt:airportTitle']?.ja || item?.['dc:title'] || airportCode,
  };
}

function isValidForDate(item, date) {
  const from = item['odpt:isValidFrom']?.slice(0, 10);
  const to = item['odpt:isValidTo']?.slice(0, 10);
  return (!from || from <= date) && (!to || to >= date);
}

function routeKey(number, from, to) {
  return `${number}|${code(from)}|${code(to)}`;
}

function flightScope(from, to, domesticAirports) {
  return domesticAirports.has(from) && domesticAirports.has(to) ? 'domestic' : 'international';
}

function timeToMinutes(time) {
  if (!/^\d{2}:\d{2}$/.test(time || '')) return 0;
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

async function buildFlights() {
  if (!TOKEN) throw new Error('ODPT_ACCESS_TOKEN が設定されていません');
  if (cache.data && Date.now() < cache.expiresAt) return cache.data;

  const today = jstParts();
  const tomorrow = addJstDays(today.date, 1);
  const [departures, arrivals, airportsRaw, todaySchedules, tomorrowSchedules] = await Promise.all([
    odpt('FlightInformationDeparture', { 'odpt:operator': 'odpt.Operator:JAL' }),
    odpt('FlightInformationArrival', { 'odpt:operator': 'odpt.Operator:JAL' }),
    odpt('Airport'),
    odpt('FlightSchedule', {
      'odpt:operator': 'odpt.Operator:JAL',
      'odpt:calendar': `odpt.Calendar:${today.weekday}`,
    }),
    odpt('FlightSchedule', {
      'odpt:operator': 'odpt.Operator:JAL',
      'odpt:calendar': `odpt.Calendar:${tomorrow.weekday}`,
    }),
  ]);

  const airports = new Map(airportsRaw.map((item) => [item['owl:sameAs'], item]));
  // ODPT's JAL FlightSchedule dataset is the domestic timetable. Use the
  // airports appearing in it as the domestic-airport set because Airport
  // resources do not expose an ISO country code.
  const domesticAirports = new Set();
  for (const route of [...todaySchedules, ...tomorrowSchedules]) {
    domesticAirports.add(route['odpt:originAirport']);
    domesticAirports.add(route['odpt:destinationAirport']);
  }

  const todayScheduleByFlight = new Map();
  for (const route of todaySchedules) {
    for (const item of route['odpt:flightScheduleObject'] || []) {
      if (!isValidForDate(item, today.date)) continue;
      const number = flightNumber(item['odpt:flightNumber']);
      if (!/^JL\d+/i.test(number)) continue;
      todayScheduleByFlight.set(
        routeKey(number, route['odpt:originAirport'], route['odpt:destinationAirport']),
        item,
      );
    }
  }

  const arrivalByFlight = new Map();
  for (const item of arrivals) {
    const number = flightNumber(item['odpt:flightNumber']);
    arrivalByFlight.set(routeKey(number, item['odpt:originAirport'], item['odpt:arrivalAirport']), item);
  }

  const inAir = departures
    .filter((item) => code(item['odpt:flightStatus']) === 'InAir' && /^JL\d+/i.test(flightNumber(item['odpt:flightNumber'])))
    .map((item) => {
      const number = flightNumber(item['odpt:flightNumber']);
      const key = routeKey(number, item['odpt:departureAirport'], item['odpt:destinationAirport']);
      const arrival = arrivalByFlight.get(key);
      const schedule = todayScheduleByFlight.get(key);
      const scheduledDepartureTime = schedule?.['odpt:originTime'] || item['odpt:scheduledDepartureTime'] || null;
      const scheduledArrivalTime = schedule?.['odpt:destinationTime'] || arrival?.['odpt:scheduledArrivalTime'] || null;
      const actualDepartureTime = item['odpt:actualDepartureTime'] || null;
      const actualArrivalTime = arrival?.['odpt:actualArrivalTime'] || null;
      return {
        id: item['@id'], number,
        scope: flightScope(item['odpt:departureAirport'], item['odpt:destinationAirport'], domesticAirports),
        from: airportInfo(item['odpt:departureAirport'], airports),
        to: airportInfo(item['odpt:destinationAirport'], airports),
        departureTime: actualDepartureTime || scheduledDepartureTime,
        arrivalTime: actualArrivalTime || scheduledArrivalTime,
        actualDepartureTime,
        actualArrivalTime,
        scheduledDepartureTime,
        scheduledArrivalTime,
        status: 'in-air', statusLabel: '飛行中',
        note: item['odpt:flightInformationSummary']?.ja || item['odpt:flightInformationText']?.ja || null,
        gate: item['odpt:departureGate'] || null,
        terminal: code(item['odpt:departureAirportTerminal']) || null,
        aircraft: item['odpt:aircraftType'] || null,
      };
    })
    .sort((a, b) => timeToMinutes(b.departureTime) - timeToMinutes(a.departureTime));

  const departureByFlight = new Map();
  for (const item of departures) {
    const number = flightNumber(item['odpt:flightNumber']);
    departureByFlight.set(routeKey(number, item['odpt:departureAirport'], item['odpt:destinationAirport']), item);
  }

  const seen = new Set();
  const upcoming = [];
  for (const { dateInfo, schedules } of [
    { dateInfo: today, schedules: todaySchedules },
    { dateInfo: tomorrow, schedules: tomorrowSchedules },
  ]) {
    for (const route of schedules) {
      for (const item of route['odpt:flightScheduleObject'] || []) {
        if (!isValidForDate(item, dateInfo.date)) continue;
        const number = flightNumber(item['odpt:flightNumber']);
        if (!/^JL\d+/i.test(number)) continue;
        const departureTime = item['odpt:originTime'];
        if (dateInfo.date === today.date && departureTime <= today.time) continue;
        const key = `${dateInfo.date}|${routeKey(number, route['odpt:originAirport'], route['odpt:destinationAirport'])}|${departureTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // FlightInformationDeparture is for the current operating day. Applying
        // today's status to tomorrow's same-number flight would incorrectly
        // remove it as already departed or cancelled.
        const live = dateInfo.date === today.date
          ? departureByFlight.get(routeKey(number, route['odpt:originAirport'], route['odpt:destinationAirport']))
          : null;
        const liveStatus = code(live?.['odpt:flightStatus']);
        if (liveStatus === 'Cancelled' || liveStatus === 'Departed' || liveStatus === 'InAir') continue;
        upcoming.push({
          id: key, number,
          scope: flightScope(route['odpt:originAirport'], route['odpt:destinationAirport'], domesticAirports),
          date: dateInfo.date,
          dayLabel: dateInfo.date === today.date ? '本日' : '明日',
          from: airportInfo(route['odpt:originAirport'], airports),
          to: airportInfo(route['odpt:destinationAirport'], airports),
          departureTime,
          arrivalTime: item['odpt:destinationTime'] || null,
          scheduledDepartureTime: departureTime,
          scheduledArrivalTime: item['odpt:destinationTime'] || null,
          actualDepartureTime: null,
          actualArrivalTime: null,
          status: 'scheduled', statusLabel: statusLabel(live?.['odpt:flightStatus']),
          note: live?.['odpt:flightInformationSummary']?.ja || null,
          aircraft: item['odpt:aircraftType'] || null,
        });
      }
    }
  }
  upcoming.sort((a, b) => `${a.date} ${a.departureTime}`.localeCompare(`${b.date} ${b.departureTime}`));

  const data = {
    generatedAt: new Date().toISOString(),
    date: today.date,
    inAir,
    upcoming,
    counts: {
      inAir: inAir.length,
      upcoming: upcoming.length,
      inAirDomestic: inAir.filter((flight) => flight.scope === 'domestic').length,
      inAirInternational: inAir.filter((flight) => flight.scope === 'international').length,
      upcomingDomestic: upcoming.filter((flight) => flight.scope === 'domestic').length,
      upcomingInternational: upcoming.filter((flight) => flight.scope === 'international').length,
    },
  };
  cache = { expiresAt: Date.now() + CACHE_TTL, data };
  return data;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/flights')) {
    try {
      return sendJson(res, 200, await buildFlights());
    } catch (error) {
      console.error(error.message);
      return sendJson(res, 502, { error: '最新の運航情報を取得できませんでした。しばらくしてから再試行してください。' });
    }
  }
  if (req.method === 'GET') return serveStatic(req, res);
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`JAL Flight Board: http://localhost:${PORT}`);
});
