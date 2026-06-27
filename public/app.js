const state = {
  data: { inAir: [], upcoming: [] },
  activeTab: 'inAir',
  scope: 'all',
  query: '',
  searchTarget: 'all',
  sort: 'default',
  limit: 20,
};

const list = document.querySelector('#flight-list');
const errorBox = document.querySelector('#error');
const showMore = document.querySelector('#show-more');
const visibleCount = document.querySelector('#visible-count');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function searchable(flight) {
  const values = {
    from: [flight.from.code, flight.from.name],
    to: [flight.to.code, flight.to.name],
    all: [flight.number, flight.from.code, flight.from.name, flight.to.code, flight.to.name, flight.aircraft],
  }[state.searchTarget] || [];
  return values.join(' ').toLowerCase();
}

function timeTemplate(actual, scheduled, fallback) {
  const primary = actual || scheduled || fallback;
  if (actual) {
    return `<time>${escapeHtml(primary)}</time><span class="time-meta">予定 ${escapeHtml(scheduled || '—')}</span>`;
  }
  if (primary) return `<time>${escapeHtml(primary)}</time><span class="time-meta">予定時刻</span>`;
  return '<time>—</time><span class="time-meta unavailable">時刻表未提供</span>';
}

function sortFlights(flights) {
  if (state.sort === 'default') return flights.slice();
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  const departure = (flight) => flight.scheduledDepartureTime || flight.departureTime || '99:99';
  const arrival = (flight) => flight.scheduledArrivalTime || flight.arrivalTime || '99:99';
  const compare = (left, right) => collator.compare(left, right);

  return flights.slice().sort((a, b) => {
    // Always keep today's flights before tomorrow's flights.
    const byDate = compare(a.date || '', b.date || '');
    if (byDate) return byDate;

    const primary = ({
      from: () => compare(a.from.code, b.from.code),
      to: () => compare(a.to.code, b.to.code),
      departure: () => compare(departure(a), departure(b)),
      arrival: () => compare(arrival(a), arrival(b)),
      aircraft: () => compare(a.aircraft || 'zzz', b.aircraft || 'zzz'),
    })[state.sort]?.() || 0;
    if (primary) return primary;

    // Within the same airport or aircraft type, sort chronologically.
    const byDeparture = compare(departure(a), departure(b));
    if (byDeparture) return byDeparture;
    return compare(a.number, b.number);
  });
}

function rowTemplate(flight, index) {
  return `
    <article class="flight-row" style="animation-delay:${Math.min(index * 20, 200)}ms">
      <div class="flight-number">
        <small>FLIGHT</small>
        <strong>${escapeHtml(flight.number)}</strong>
      </div>
      <div class="route">
        <div class="airport">
          ${timeTemplate(flight.actualDepartureTime, flight.scheduledDepartureTime, flight.departureTime)}
          <strong>${escapeHtml(flight.from.name)}</strong><small>${escapeHtml(flight.from.code)}</small>
        </div>
        <div class="route-visual"><span class="line"><span class="mini-plane">✈</span></span></div>
        <div class="airport">
          ${timeTemplate(flight.actualArrivalTime, flight.scheduledArrivalTime, flight.arrivalTime)}
          <strong>${escapeHtml(flight.to.name)}</strong><small>${escapeHtml(flight.to.code)}</small>
        </div>
      </div>
      <div class="status-cell">
        <span class="status-badge ${escapeHtml(flight.status)}">${escapeHtml(flight.statusLabel)}</span>
        ${flight.note ? `<span class="status-note">${escapeHtml(flight.note)}</span>` : ''}
        <span class="aircraft">機種 ${escapeHtml(flight.aircraft || '—')}</span>
      </div>
    </article>`;
}

function dateHeading(flight) {
  const formatted = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date(`${flight.date}T00:00:00+09:00`));
  return { label: flight.dayLabel || flight.date, formatted };
}

function groupedRowsTemplate(shown, filtered) {
  if (state.activeTab !== 'upcoming') return shown.map(rowTemplate).join('');

  const totals = filtered.reduce((counts, flight) => {
    counts[flight.date] = (counts[flight.date] || 0) + 1;
    return counts;
  }, {});
  const groups = [];
  for (const flight of shown) {
    let group = groups.at(-1);
    if (!group || group.date !== flight.date) {
      group = { date: flight.date, heading: dateHeading(flight), flights: [] };
      groups.push(group);
    }
    group.flights.push(flight);
  }

  return groups.map((group) => `
    <section class="day-group" aria-label="${escapeHtml(group.heading.label)}の便">
      <div class="day-divider">
        <span><strong>${escapeHtml(group.heading.label)}</strong>${escapeHtml(group.heading.formatted)}</span>
        <b>${totals[group.date]}便</b>
      </div>
      ${group.flights.map(rowTemplate).join('')}
    </section>`).join('');
}

function render() {
  const source = state.data[state.activeTab] || [];
  const scoped = state.scope === 'all' ? source : source.filter((flight) => flight.scope === state.scope);
  const filtered = sortFlights(scoped.filter((flight) => searchable(flight).includes(state.query)));
  const shown = filtered.slice(0, state.limit);

  document.querySelector('#scope-all-count').textContent = source.length;
  document.querySelector('#scope-domestic-count').textContent = source.filter((flight) => flight.scope === 'domestic').length;
  document.querySelector('#scope-international-count').textContent = source.filter((flight) => flight.scope === 'international').length;

  if (!shown.length) {
    list.innerHTML = `<div class="empty"><p>${state.query ? '検索条件に一致する便はありません' : '現在、該当する便はありません'}</p></div>`;
  } else {
    list.innerHTML = groupedRowsTemplate(shown, filtered);
  }
  visibleCount.textContent = `${shown.length} / ${filtered.length}便を表示`;
  showMore.hidden = shown.length >= filtered.length;
  if (!showMore.hidden) showMore.textContent = `全${filtered.length}便を表示（残り ${filtered.length - shown.length}便）`;
}

function formatUpdated(iso) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(iso)) + ' 更新';
}

async function loadFlights({ silent = false } = {}) {
  if (!silent) errorBox.hidden = true;
  try {
    const response = await fetch('/api/flights', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '運航情報を取得できませんでした');
    state.data = data;
    document.querySelector('#in-air-count').textContent = data.counts.inAir;
    document.querySelector('#upcoming-count').textContent = data.counts.upcoming;
    document.querySelector('#hero-count').textContent = data.counts.inAir;
    document.querySelector('#updated-at').textContent = formatUpdated(data.generatedAt);
    errorBox.hidden = true;
    render();
  } catch (error) {
    if (!state.data.inAir.length && !state.data.upcoming.length) list.innerHTML = '<div class="empty"><p>運航情報を表示できません</p></div>';
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    state.activeTab = tab.dataset.tab;
    state.limit = 20;
    render();
  });
});

document.querySelectorAll('.scope-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.scope-tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    state.scope = tab.dataset.scope;
    state.limit = 20;
    render();
  });
});

document.querySelector('#search').addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  state.limit = 20;
  render();
});

document.querySelector('#search-target').addEventListener('change', (event) => {
  state.searchTarget = event.target.value;
  const placeholders = {
    all: '便名・空港・機種で検索',
    from: '出発空港で検索',
    to: '到着空港で検索',
  };
  document.querySelector('#search').placeholder = placeholders[state.searchTarget];
  state.limit = 20;
  render();
});

document.querySelector('#sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  state.limit = 20;
  render();
});

showMore.addEventListener('click', () => {
  state.limit = Number.POSITIVE_INFINITY;
  render();
});

loadFlights();
setInterval(() => loadFlights({ silent: true }), 60_000);
