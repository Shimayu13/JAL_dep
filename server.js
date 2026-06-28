const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.ODPT_ACCESS_TOKEN;
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_ROOT = 'https://api.odpt.org/api/v4';
const CACHE_TTL = 30_000;
const cache = new Map();

const AIRLINES = {
  JAL: { key: 'JAL', operator: 'odpt.Operator:JAL', prefix: 'JL', source: 'odpt' },
  ANA: { key: 'ANA', operator: 'odpt.Operator:ANA', prefix: 'NH', source: 'odpt' },
  SKY: { key: 'SKY', prefix: 'SKY', source: 'csv' },
};

const SKYMARK_CSV = path.join(__dirname, 'Skymark_timetable.csv');
const LOCAL_AIRPORT_NAMES = {
  ASJ: '奄美', CTS: '札幌(新千歳)', FUK: '福岡', HND: '東京(羽田)',
  IBR: '茨城', KOJ: '鹿児島', NGO: '名古屋(中部)', NGS: '長崎',
  OKA: '沖縄(那覇)', SDJ: '仙台', SHI: '下地島', UKB: '神戸',
};

// ODPT Airport resources do not include country codes. Keep an explicit set
// for route classification because ANA's schedule includes international
// routes as well as domestic routes.
const JAPAN_AIRPORT_CODES = new Set([
  'AGJ', 'AKJ', 'AOJ', 'ASJ', 'AXJ', 'AXT', 'CTS', 'FKS', 'FSZ', 'FUJ',
  'FUK', 'GAJ', 'HAC', 'HIJ', 'HKD', 'HND', 'HNA', 'HSG', 'HTR', 'IBR',
  'IEJ', 'IKI', 'ISG', 'ITM', 'IWJ', 'IWO', 'IZO', 'KCZ', 'KIJ', 'KIX',
  'KMI', 'KKJ', 'KKX', 'KMQ', 'KMJ', 'KOJ', 'KTD', 'KUH', 'KUM', 'MBE',
  'MMD', 'MMB', 'MMJ', 'MMY', 'MSJ', 'MYE', 'MYJ', 'NGO', 'NGS', 'NKM',
  'NRT', 'NTQ', 'OBO', 'OGN', 'OIM', 'OIT', 'OKA', 'OKD', 'OKE', 'OKI',
  'ONJ', 'RIS', 'RNJ', 'SDJ', 'SDS', 'SHB', 'SHI', 'SHM', 'SYO', 'TAK',
  'TJH', 'TKN', 'TKS', 'TNE', 'TOY', 'TRA', 'TSJ', 'TTJ', 'UBJ', 'UEO',
  'UKB', 'WKJ', 'YGJ',
]);

const AMERICAS_AIRPORT_CODES = new Set([
  'ANC', 'ATL', 'BOS', 'DFW', 'EWR', 'GRU', 'HNL', 'IAD', 'IAH', 'JFK',
  'KOA', 'LAS', 'LAX', 'MCO', 'MEX', 'MSP', 'ORD', 'PDX', 'SAN', 'SEA',
  'SFO', 'SJC', 'YUL', 'YVR', 'YYC', 'YYZ',
]);

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

function flightNumber(value, prefix) {
  const values = Array.isArray(value) ? value : [value];
  const pattern = new RegExp(`^${prefix}\\d+`, 'i');
  return values.map(String).find((item) => pattern.test(item)) || values[0] || '—';
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

function localAirportInfo(airportCode) {
  return { code: airportCode, name: LOCAL_AIRPORT_NAMES[airportCode] || airportCode };
}

function isValidForDate(item, date) {
  const from = item['odpt:isValidFrom']?.slice(0, 10);
  const to = item['odpt:isValidTo']?.slice(0, 10);
  return (!from || from <= date) && (!to || to >= date);
}

function routeKey(number, from, to) {
  return `${number}|${code(from)}|${code(to)}`;
}

function flightScope(from, to) {
  return JAPAN_AIRPORT_CODES.has(code(from)) && JAPAN_AIRPORT_CODES.has(code(to)) ? 'domestic' : 'international';
}

function timeToMinutes(time) {
  if (!/^\d{2}:\d{2}$/.test(time || '')) return 0;
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function arrivalDayOffset(departureTime, arrivalTime, from, to) {
  if (!departureTime || !arrivalTime) return 0;
  const fromCode = code(from);
  const toCode = code(to);
  // Trans-Pacific flights cross the date line: Japan-to-Americas arrives on
  // the same local date, while Americas-to-Japan arrives the following date.
  if (JAPAN_AIRPORT_CODES.has(fromCode) && AMERICAS_AIRPORT_CODES.has(toCode)) return 0;
  if (AMERICAS_AIRPORT_CODES.has(fromCode) && JAPAN_AIRPORT_CODES.has(toCode)) return 1;
  return timeToMinutes(arrivalTime) < timeToMinutes(departureTime) ? 1 : 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [headers = [], ...records] = rows;
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function normalizeTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function isPeriodActive(period, dateString) {
  const match = String(period || '').match(/(\d{1,2})\/(\d{1,2})\D+(\d{1,2})\/(\d{1,2})/);
  if (!match) return false;
  const current = Number(dateString.slice(5, 7)) * 100 + Number(dateString.slice(8, 10));
  const start = Number(match[1]) * 100 + Number(match[2]);
  const end = Number(match[3]) * 100 + Number(match[4]);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function csvFlightsForDate(rows, dateInfo) {
  return rows.filter((row) => row[dateInfo.weekday] === 'Y' && isPeriodActive(row.Period, dateInfo.date));
}

function jstDateTime(dateString, time) {
  return new Date(`${dateString}T${time}:00+09:00`);
}

async function buildSkymarkFlights() {
  const cached = cache.get('SKY');
  if (cached?.data && Date.now() < cached.expiresAt) return cached.data;

  const rows = parseCsv(await fs.promises.readFile(SKYMARK_CSV, 'utf8'));
  const now = new Date();
  const today = jstParts(now);
  const yesterday = addJstDays(today.date, -1);
  const tomorrow = addJstDays(today.date, 1);
  const seen = new Set();

  const makeFlight = (row, dateInfo, status) => {
    const departureTime = normalizeTime(row.Departure);
    const arrivalTime = normalizeTime(row.Arrival);
    const offset = arrivalDayOffset(departureTime, arrivalTime, row.Origin, row.Destination);
    const key = `${dateInfo.date}|${row.Flight}|${row.Origin}|${row.Destination}|${departureTime}`;
    return {
      id: key,
      number: row.Flight,
      scope: flightScope(row.Origin, row.Destination),
      date: dateInfo.date,
      dayLabel: dateInfo.date === today.date ? '本日' : dateInfo.date === tomorrow.date ? '明日' : '前日',
      from: localAirportInfo(row.Origin),
      to: localAirportInfo(row.Destination),
      departureTime,
      arrivalTime,
      scheduledDepartureTime: departureTime,
      scheduledArrivalTime: arrivalTime,
      actualDepartureTime: null,
      actualArrivalTime: null,
      arrivalDayOffset: offset,
      status,
      statusLabel: status === 'in-air-estimated' ? '飛行中（推定）' : '時刻表',
      note: status === 'in-air-estimated' ? 'CSV時刻表から推定' : null,
      aircraft: row.aircraft || null,
    };
  };

  const inAir = [];
  for (const dateInfo of [yesterday, today]) {
    for (const row of csvFlightsForDate(rows, dateInfo)) {
      const flight = makeFlight(row, dateInfo, 'in-air-estimated');
      const departureAt = jstDateTime(dateInfo.date, flight.departureTime);
      const arrivalDate = flight.arrivalDayOffset ? addJstDays(dateInfo.date, flight.arrivalDayOffset).date : dateInfo.date;
      const arrivalAt = jstDateTime(arrivalDate, flight.arrivalTime);
      if (departureAt <= now && now < arrivalAt && !seen.has(flight.id)) {
        seen.add(flight.id);
        inAir.push(flight);
      }
    }
  }
  inAir.sort((a, b) => timeToMinutes(b.departureTime) - timeToMinutes(a.departureTime));

  const upcoming = [];
  for (const dateInfo of [today, tomorrow]) {
    for (const row of csvFlightsForDate(rows, dateInfo)) {
      const flight = makeFlight(row, dateInfo, 'scheduled');
      if (dateInfo.date === today.date && flight.departureTime <= today.time) continue;
      if (seen.has(flight.id)) continue;
      seen.add(flight.id);
      upcoming.push(flight);
    }
  }
  upcoming.sort((a, b) => `${a.date} ${a.departureTime}`.localeCompare(`${b.date} ${b.departureTime}`));

  const data = {
    airline: 'SKY',
    source: 'csv',
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
  cache.set('SKY', { expiresAt: Date.now() + CACHE_TTL, data });
  return data;
}

async function buildFlights(airlineKey = 'JAL') {
  const airline = AIRLINES[airlineKey] || AIRLINES.JAL;
  if (airline.source === 'csv') return buildSkymarkFlights();
  if (!TOKEN) throw new Error('ODPT_ACCESS_TOKEN が設定されていません');
  const cached = cache.get(airline.key);
  if (cached?.data && Date.now() < cached.expiresAt) return cached.data;

  const today = jstParts();
  const tomorrow = addJstDays(today.date, 1);
  const [departures, arrivals, airportsRaw, todaySchedules, tomorrowSchedules] = await Promise.all([
    odpt('FlightInformationDeparture', { 'odpt:operator': airline.operator }),
    odpt('FlightInformationArrival', { 'odpt:operator': airline.operator }),
    odpt('Airport'),
    odpt('FlightSchedule', {
      'odpt:operator': airline.operator,
      'odpt:calendar': `odpt.Calendar:${today.weekday}`,
    }),
    odpt('FlightSchedule', {
      'odpt:operator': airline.operator,
      'odpt:calendar': `odpt.Calendar:${tomorrow.weekday}`,
    }),
  ]);

  const airports = new Map(airportsRaw.map((item) => [item['owl:sameAs'], item]));
  const todayScheduleByFlight = new Map();
  for (const route of todaySchedules) {
    for (const item of route['odpt:flightScheduleObject'] || []) {
      if (!isValidForDate(item, today.date)) continue;
      const number = flightNumber(item['odpt:flightNumber'], airline.prefix);
      if (!number.toUpperCase().startsWith(airline.prefix)) continue;
      todayScheduleByFlight.set(
        routeKey(number, route['odpt:originAirport'], route['odpt:destinationAirport']),
        item,
      );
    }
  }

  const arrivalByFlight = new Map();
  for (const item of arrivals) {
    const number = flightNumber(item['odpt:flightNumber'], airline.prefix);
    arrivalByFlight.set(routeKey(number, item['odpt:originAirport'], item['odpt:arrivalAirport']), item);
  }

  const inAir = departures
    .filter((item) => code(item['odpt:flightStatus']) === 'InAir'
      && flightNumber(item['odpt:flightNumber'], airline.prefix).toUpperCase().startsWith(airline.prefix))
    .map((item) => {
      const number = flightNumber(item['odpt:flightNumber'], airline.prefix);
      const key = routeKey(number, item['odpt:departureAirport'], item['odpt:destinationAirport']);
      const arrival = arrivalByFlight.get(key);
      const schedule = todayScheduleByFlight.get(key);
      const scheduledDepartureTime = schedule?.['odpt:originTime'] || item['odpt:scheduledDepartureTime'] || null;
      const scheduledArrivalTime = schedule?.['odpt:destinationTime'] || arrival?.['odpt:scheduledArrivalTime'] || null;
      const actualDepartureTime = item['odpt:actualDepartureTime'] || null;
      const actualArrivalTime = arrival?.['odpt:actualArrivalTime'] || null;
      return {
        id: item['@id'], number,
        scope: flightScope(item['odpt:departureAirport'], item['odpt:destinationAirport']),
        from: airportInfo(item['odpt:departureAirport'], airports),
        to: airportInfo(item['odpt:destinationAirport'], airports),
        departureTime: actualDepartureTime || scheduledDepartureTime,
        arrivalTime: actualArrivalTime || scheduledArrivalTime,
        actualDepartureTime,
        actualArrivalTime,
        scheduledDepartureTime,
        scheduledArrivalTime,
        arrivalDayOffset: arrivalDayOffset(
          scheduledDepartureTime,
          scheduledArrivalTime,
          item['odpt:departureAirport'],
          item['odpt:destinationAirport'],
        ),
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
    const number = flightNumber(item['odpt:flightNumber'], airline.prefix);
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
        const number = flightNumber(item['odpt:flightNumber'], airline.prefix);
        if (!number.toUpperCase().startsWith(airline.prefix)) continue;
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
          scope: flightScope(route['odpt:originAirport'], route['odpt:destinationAirport']),
          date: dateInfo.date,
          dayLabel: dateInfo.date === today.date ? '本日' : '明日',
          from: airportInfo(route['odpt:originAirport'], airports),
          to: airportInfo(route['odpt:destinationAirport'], airports),
          departureTime,
          arrivalTime: item['odpt:destinationTime'] || null,
          scheduledDepartureTime: departureTime,
          scheduledArrivalTime: item['odpt:destinationTime'] || null,
          arrivalDayOffset: arrivalDayOffset(
            departureTime,
            item['odpt:destinationTime'],
            route['odpt:originAirport'],
            route['odpt:destinationAirport'],
          ),
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
    airline: airline.key,
    source: 'odpt',
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
  cache.set(airline.key, { expiresAt: Date.now() + CACHE_TTL, data });
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
      const url = new URL(req.url, 'http://localhost');
      const airline = String(url.searchParams.get('airline') || 'JAL').toUpperCase();
      if (!AIRLINES[airline]) return sendJson(res, 400, { error: '対応していない航空会社です。' });
      return sendJson(res, 200, await buildFlights(airline));
    } catch (error) {
      console.error(error.message);
      return sendJson(res, 502, { error: '最新の運航情報を取得できませんでした。しばらくしてから再試行してください。' });
    }
  }
  if (req.method === 'GET') return serveStatic(req, res);
  sendJson(res, 405, { error: 'Method not allowed' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Flight Board: http://localhost:${PORT}`);
  });
}

module.exports = {
  AIRLINES, AMERICAS_AIRPORT_CODES, JAPAN_AIRPORT_CODES,
  arrivalDayOffset, buildSkymarkFlights, flightNumber, flightScope,
  isPeriodActive, normalizeTime, parseCsv,
};
