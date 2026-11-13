/* ABC Delivery Control Tower — demo dashboard (vanilla JS, no build step). */
(function () {
  'use strict';

  // ---------------- helpers ----------------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  const fmtPct = (n, d = 1) => (n == null ? '–' : `${Number(n).toFixed(d)}%`);
  const LABEL = { good: 'On track', warn: 'At risk', bad: 'Off track', neutral: 'No data', on_time: 'On time', at_risk: 'At risk', delayed: 'Delayed', at_hub: 'At hub', behind: 'Behind', on_track: 'On track', idle: 'Idle', absent: 'Absent', critical: 'Critical', warning: 'Warning', pending: 'Pending', acknowledged: 'Acknowledged', open: 'Open', done: 'Done', active: 'In progress' };
  const pill = (st, text) => `<span class="pill ${esc(st)}">${esc(text || LABEL[st] || st)}</span>`;
  const tClass = (st) => (st === 'good' || st === 'on_time' ? 't-good' : st === 'warn' || st === 'at_risk' ? 't-warn' : st === 'bad' || st === 'delayed' ? 't-bad' : '');
  const COLORS = { good: '#1d4ed8', warn: '#b45309', bad: '#b91c1c', grey: '#8a94a3', ink: '#1a1d21' };
  const healthColor = (h) => (h === 'delayed' ? COLORS.bad : h === 'at_risk' ? COLORS.warn : h === 'on_time' ? COLORS.good : COLORS.grey);
  const ago = (m) => (m <= 0 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`);

  async function apiGet(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  async function apiPost(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (r.status === 204) return {};
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------------- app state ----------------
  const app = { meta: null, route: null, view: null, timer: null, charts: [], map: null, mapLayers: {}, filter: 'all', alertFilter: 'all', busy: false };
  const REFRESH_MS = 5000;
  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // ---------------- shared renderers ----------------
  function kpiCard({ label, value, unit = '', status, foot, small }) {
    const v = value == null ? '–' : unit === '$' ? `$${Number(value).toFixed(2)}` : unit === '%' ? `${value}%` : fmt(value);
    return `<div class="card"><div class="kpi-label"><span>${esc(label)}</span>${status ? pill(status) : ''}</div>
      <div class="kpi-value num">${v}${small ? ` <small>${esc(small)}</small>` : ''}</div>
      <div class="kpi-foot">${foot || ''}</div></div>`;
  }
  function delta(d, unit, lowerIsBetter = false) {
    if (d == null || isNaN(d)) return '';
    const up = d > 0;
    const good = lowerIsBetter ? !up : up;
    const val = unit === '$' ? `$${Math.abs(d).toFixed(2)}` : `${Math.abs(d).toFixed(1)} pts`;
    return `<span class="${d === 0 ? '' : good ? 't-good' : 't-bad'}">${up ? '▲' : d < 0 ? '▼' : '•'} ${val}</span> vs last week`;
  }
  function alertCard(a, opts = {}) {
    const link = a.tripId ? `<a class="btn" href="#/trip/${esc(a.tripId)}">Open trip</a>` : a.hubId && !opts.inHub ? `<a class="btn" href="#/hub/${esc(a.hubId)}">Open hub</a>` : '';
    const ack = a.status === 'open' ? `<button class="btn" data-action="ack" data-id="${esc(a.id)}">Acknowledge</button>` : '';
    const resolve = `<button class="btn" data-action="resolve" data-id="${esc(a.id)}">Resolve</button>`;
    return `<div class="alert ${esc(a.severity)} ${a.status === 'acknowledged' ? 'acknowledged' : ''}">
      <div class="alert-meta">${pill(a.severity)} <span class="tl-time">${esc(ago(a.age))} · ${esc(a.regionName || '')}</span>
        ${a.status === 'acknowledged' ? pill('acknowledged') : `<span class="tl-time">Escalates to: ${esc(a.escalation)}</span>`}</div>
      <div class="alert-title">${esc(a.title)}</div>
      <div class="alert-detail">${esc(a.detail)}</div>
      <div class="alert-actions">${link}${ack}${resolve}</div></div>`;
  }
  function destroyCharts() { app.charts.forEach((c) => c.destroy()); app.charts = []; }
  function destroyMap() { if (app.map) { app.map.remove(); app.map = null; app.mapLayers = {}; } }
  function lineChart(canvas, labels, datasets, opts = {}) {
    if (!window.Chart) { canvas.parentElement.innerHTML = '<div class="empty">Chart library could not load (offline?).</div>'; return null; }
    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 12, font: { size: 12 } } } },
        scales: { y: { min: opts.min, max: opts.max, ticks: { callback: opts.tick || ((v) => v) }, grid: { color: '#eceef1' } }, x: { grid: { display: false } } },
      },
    });
    app.charts.push(chart);
    return chart;
  }
  const targetLine = (n, value, label) => ({ label, data: Array(n).fill(value), borderColor: '#5b6470', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false });

  function clockText(c) {
    if (!c) return '';
    const win = c.windowProgress >= 100 ? 'delivery window closed' : c.windowProgress <= 0 ? 'before delivery window' : `${c.windowProgress}% through delivery window`;
    return `Day ${c.day} · ${c.time} · ${win}`;
  }

  // ---------------- views ----------------
  const views = {};

  // ---- CEO ----
  views.ceo = {
    depth: 0,
    mount: () => `
      <div class="page-head"><div><div class="crumbs">Network › Overview</div>
        <h1>Are we keeping our delivery promise at the right cost?</h1>
        <div class="sub">CEO view · 16 regions · 1,000 hubs · updates every 5 seconds</div></div></div>
      <section class="grid-kpi" id="kpis" aria-label="Headline metrics"></section>
      <div class="row">
        <section class="card wide" aria-label="On-time trend"><div class="card-head"><h2>On-time delivery, last 12 weeks + today</h2><span class="card-note">Dashed: 95% target</span></div><div class="chart-box"><canvas id="trend"></canvas></div></section>
        <section class="card" aria-label="Owned vs hired fleet"><div class="card-head"><h2>Owned vs hired fleet</h2></div><div id="fleet"></div></section>
      </div>
      <section class="card" aria-label="Regions"><div class="card-head"><h2>On-time delivery by region · click to drill down</h2><span class="card-note">Blue on track · orange at risk · outlined off track</span></div><div class="heat" id="heat"></div></section>
      <section class="card" aria-label="Top risks"><div class="card-head"><h2>Top risks right now</h2></div><ol class="risks" id="risks"></ol></section>`,
    load: () => apiGet('/api/ceo'),
    update(d) {
      const k = d.kpis;
      $('#kpis').innerHTML = [
        kpiCard({ label: 'On-time delivery', value: k.otd.value, unit: '%', status: k.otd.status, foot: `Target ${k.otd.target}% · ${delta(k.otd.delta)}` }),
        kpiCard({ label: 'Cost per parcel', value: k.costPerParcel.value, unit: '$', status: k.costPerParcel.status, foot: `Target $${k.costPerParcel.target.toFixed(2)} · ${delta(k.costPerParcel.delta, '$', true)}` }),
        kpiCard({ label: 'Parcels delivered today', value: k.volume.value, status: k.volume.status, foot: `${fmt(k.volume.plan)} due so far · ${fmt(k.volume.planDay)} planned today` }),
        kpiCard({ label: 'Damage and loss', value: k.damage.value, unit: '%', status: k.damage.status, foot: `Target under ${k.damage.target}%` }),
      ].join('');
      const labels = d.trend.map((t) => t.label);
      const data = d.trend.map((t) => t.otd);
      if (!this.chart) {
        this.chart = lineChart($('#trend'), labels, [
          { label: 'On-time delivery %', data, borderColor: COLORS.good, backgroundColor: COLORS.good, borderWidth: 3, tension: 0.25, pointRadius: data.map((_, i) => (i === data.length - 1 ? 6 : 2)), pointBackgroundColor: data.map((_, i) => (i === data.length - 1 ? COLORS.warn : COLORS.good)) },
          targetLine(labels.length, 95, 'Target 95%'),
        ], { tick: (v) => `${v}%` });
      } else { this.chart.data.datasets[0].data = data; this.chart.update('none'); }
      const f = d.fleet;
      $('#fleet').innerHTML = `<div class="compare">
        <div></div><div class="h">Owned (${f.owned.vehicles})</div><div class="h">Hired (${f.hired.vehicles})</div>
        <div class="l">Cost per mile</div><div class="num">$${f.owned.costPerMile.toFixed(2)}</div><div class="num">$${f.hired.costPerMile.toFixed(2)}</div>
        <div class="l">On-time departure</div><div class="num">${fmtPct(f.owned.onTimeDeparture, 0)}</div><div class="num ${f.hired.onTimeDeparture < 90 ? 't-bad' : ''}">${fmtPct(f.hired.onTimeDeparture, 0)}</div>
        <div class="l">Avg load utilization</div><div class="num">${fmtPct(f.owned.utilization, 0)}</div><div class="num">${fmtPct(f.hired.utilization, 0)}</div>
        <div class="l">Delayed right now</div><div class="num">${f.owned.delayedNow}</div><div class="num">${f.hired.delayedNow}</div></div>
        <p class="sub" style="line-height:1.5;margin-top:14px">Hired vehicles cost ${Math.round((f.hired.costPerMile / f.owned.costPerMile - 1) * 100)}% more per mile. Lanes that need the most hired trucks are candidates for owned capacity (Q4 buy-or-hire model).</p>`;
      $('#heat').innerHTML = d.regions.map((r) => `<a class="${esc(r.otdStatus)}" href="#/region/${esc(r.id)}"><div class="name">${esc(r.name)}</div><div class="val num">${fmtPct(r.otd)}</div><div class="kpi-foot">${LABEL[r.otdStatus]} · ${r.openAlerts} alerts</div></a>`).join('');
      $('#risks').innerHTML = d.risks.map((r) => `<li>${esc(r.text)} <a href="${esc(r.link)}">Open</a></li>`).join('');
    },
  };

  // ---- Operations Head / live network ----
  views.ops = {
    depth: 0,
    mount: () => `
      <div class="page-head"><div><div class="crumbs">Network › Live map</div><h1>Network control tower</h1>
        <div class="sub">Operations Head view · 200 vehicles · click a vehicle to open its trip</div></div></div>
      <section class="grid-kpi" id="kpis" aria-label="Headline metrics"></section>
      <div class="row">
        <section class="card wide" aria-label="Live map">
          <div class="card-head"><h2>All vehicles</h2>
            <div class="seg" role="group" aria-label="Fleet filter">
              <button data-action="filter" data-f="all">All</button><button data-action="filter" data-f="owned">Owned</button><button data-action="filter" data-f="hired">Hired</button><button data-action="filter" data-f="delayed">Delayed only</button>
            </div></div>
          <div id="map" role="region" aria-label="Map of vehicles and sorting hubs"></div>
          <div class="map-legend"><span><i class="lg sort"></i>Sorting hub</span><span><i class="lg on"></i>On time</span><span><i class="lg risk"></i>At risk (15–30 min)</span><span><i class="lg del"></i>Delayed (30+ min)</span><span><i class="lg hub"></i>Waiting at hub</span></div>
        </section>
        <aside class="card" aria-label="Alerts"><div class="card-head"><h2 id="alert-head">Alerts</h2><a href="#/alerts" class="card-note">View all</a></div><div class="alerts" id="alerts"></div></aside>
      </div>
      <div class="row">
        <section class="card wide"><div class="card-head"><h2>Regional leaderboard · worst first</h2></div><div class="table-wrap" id="leaderboard"></div></section>
        <section class="card"><div class="card-head"><h2>Fleet vendors today</h2><span class="card-note">On-time departure</span></div><div class="table-wrap" id="vendors"></div></section>
      </div>`,
    afterMount() { initNetworkMap(); },
    load: () => apiGet('/api/ops'),
    update(d) {
      const k = d.kpis;
      $('#kpis').innerHTML = [
        kpiCard({ label: 'On-time delivery today', value: k.otd.value, unit: '%', status: k.otd.status, foot: 'Target 95%' }),
        kpiCard({ label: 'Line-haul arrived before cut-off', value: k.lineHaulBeforeCutoff.value, unit: '%', status: k.lineHaulBeforeCutoff.status, foot: 'Target 95% · trips completed today' }),
        kpiCard({ label: 'Vehicles delayed now', value: k.vehiclesDelayed.value, small: `of ${k.vehiclesDelayed.total}`, status: k.vehiclesDelayed.status, foot: `${k.vehiclesDelayed.hired} hired · ${k.vehiclesDelayed.owned} owned` }),
        kpiCard({ label: 'Open critical alerts', value: k.criticalAlerts.value, status: k.criticalAlerts.status, foot: `Median age ${k.criticalAlerts.medianAge} min` }),
      ].join('');
      updateNetworkMap(d);
      $('#alert-head').textContent = `Alerts · ${d.alertCounts.critical} critical, ${d.alertCounts.warning} warning`;
      $('#alerts').innerHTML = d.alerts.length ? d.alerts.slice(0, 5).map((a) => alertCard(a)).join('') : '<div class="empty">No open alerts. Nice.</div>';
      $('#leaderboard').innerHTML = `<table><thead><tr><th>Region</th><th>On-time</th><th>Before cut-off</th><th>First-attempt</th><th>Cost / parcel</th><th>Backlog</th><th>Alerts</th></tr></thead><tbody>${d.leaderboard.map((r) => `<tr><td><a href="#/region/${esc(r.id)}"><b>${esc(r.name)}</b></a></td><td class="num ${tClass(r.otdStatus)}"><b>${fmtPct(r.otd)}</b></td><td class="num">${fmtPct(r.lineHaulBeforeCutoff, 0)}</td><td class="num">${fmtPct(r.fads)}</td><td class="num">$${r.costPerParcel.toFixed(2)}</td><td class="num">${fmt(r.backlog)}</td><td class="num">${r.openAlerts}</td></tr>`).join('')}</tbody></table>`;
      $('#vendors').innerHTML = vendorTable(d.vendors);
    },
  };

  function vendorTable(vendors) {
    return `<table><thead><tr><th>Vendor</th><th>On-time dep.</th><th>Trips</th><th>$/mile</th></tr></thead><tbody>${vendors.map((v) => `<tr><td><b>${esc(v.vendor)}</b></td><td class="num ${tClass(v.status)}">${fmtPct(v.onTimeDeparture, 0)}</td><td class="num">${v.trips}</td><td class="num">$${v.costPerMile.toFixed(2)}</td></tr>`).join('')}</tbody></table>`;
  }

  function vehicleIcon(v) {
    const c = healthColor(v.health);
    const shape = v.health === 'delayed' ? 'border-radius:2px' : v.health === 'at_risk' ? 'transform:rotate(45deg);border-radius:2px' : 'border-radius:50%';
    const size = v.health === 'at_hub' ? 8 : v.health === 'on_time' ? 11 : 13;
    return L.divIcon({ className: '', html: `<div style="width:${size}px;height:${size}px;background:${c};border:2px solid #fff;box-shadow:0 0 0 1px ${c};${shape}"></div>`, iconSize: [size + 4, size + 4], iconAnchor: [(size + 4) / 2, (size + 4) / 2] });
  }
  function initNetworkMap() {
    if (!window.L) { $('#map').innerHTML = '<div class="empty" style="padding:20px">Map library could not load (offline?).</div>'; return; }
    destroyMap();
    const map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([38.5, -96], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(map);
    app.map = map;
    app.mapLayers = { lanes: L.layerGroup().addTo(map), hubs: L.layerGroup().addTo(map), vehicles: L.layerGroup().addTo(map), markers: {} };
    setTimeout(() => map.invalidateSize(), 50);
  }
  function updateNetworkMap(d) {
    if (!app.map) return;
    const ly = app.mapLayers;
    if (!ly.drawnStatic) {
      d.lanes.forEach((l) => L.polyline([l.a, l.b], { color: '#9aa3af', weight: 1.5, dashArray: '4 6' }).addTo(ly.lanes));
      d.sortHubs.forEach((h) => L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html: '<div class="sort-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).bindTooltip(esc(h.name)).on('click', () => { location.hash = `#/region/${h.regionId}`; }).addTo(ly.hubs));
      ly.drawnStatic = true;
    }
    const f = app.filter;
    const keep = new Set();
    d.vehicles.forEach((v) => {
      const show = f === 'all' || (f === 'owned' && v.owned) || (f === 'hired' && !v.owned) || (f === 'delayed' && v.health === 'delayed');
      let m = ly.markers[v.id];
      if (!show) { if (m) { ly.vehicles.removeLayer(m); delete ly.markers[v.id]; } return; }
      keep.add(v.id);
      const tip = `<b>${esc(v.id)}</b> · ${v.owned ? 'Owned' : esc(v.vendor)}<br>${v.from ? `${esc(v.from)} → ${esc(v.to)}<br>` : 'Waiting at hub<br>'}${v.health !== 'at_hub' ? `${LABEL[v.health]}${v.delayMin > 0 ? ` · +${v.delayMin} min` : ''}` : ''}`;
      if (!m) {
        m = L.marker([v.lat, v.lng], { icon: vehicleIcon(v), zIndexOffset: v.health === 'delayed' ? 900 : v.health === 'at_risk' ? 500 : 0 });
        m.on('click', () => { if (m._tripId) location.hash = `#/trip/${m._tripId}`; });
        m.addTo(ly.vehicles);
        ly.markers[v.id] = m;
      } else {
        m.setLatLng([v.lat, v.lng]);
        if (m._health !== v.health) { m.setIcon(vehicleIcon(v)); m.setZIndexOffset(v.health === 'delayed' ? 900 : v.health === 'at_risk' ? 500 : 0); }
      }
      m._tripId = v.tripId; m._health = v.health;
      m.unbindTooltip();
      if (v.health === 'delayed') m.bindTooltip(`${esc(v.id)} +${v.delayMin}m`, { permanent: true, direction: 'right', className: 'veh-label', offset: [8, 0] });
      else m.bindTooltip(tip);
    });
    Object.keys(ly.markers).forEach((id) => { if (!keep.has(id)) { ly.vehicles.removeLayer(ly.markers[id]); delete ly.markers[id]; } });
    document.querySelectorAll('[data-action="filter"]').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
  }

  // ---- Region ----
  views.region = {
    depth: 1,
    mount: (id) => `
      <div class="page-head"><div><div class="crumbs"><a href="#/ceo">Network</a> › <span id="r-crumb">Region</span></div><h1 id="r-title">Region</h1><div class="sub" id="r-sub"></div></div></div>
      <section class="grid-kpi" id="kpis"></section>
      <section class="card" aria-label="Inbound line-haul"><div class="card-head"><h2 id="lane-title">Inbound line-haul vs sort cut-off</h2><span class="card-note">Outline: planned · Bar: actual / ETA · Dashed: cut-off · Green: now</span></div><div id="lanes"></div></section>
      <div class="row">
        <section class="card wide"><div class="card-head"><h2>Hubs · worst first</h2><span class="card-note" id="hub-count"></span></div><div class="table-wrap" id="hubs"></div></section>
        <section class="card"><div class="card-head"><h2>Hired-fleet vendors</h2></div><div class="table-wrap" id="vendors"></div></section>
      </div>
      <div class="row">
        <section class="card wide"><div class="card-head"><h2>On-time and first-attempt success, 12 weeks</h2></div><div class="chart-box"><canvas id="rtrend"></canvas></div></section>
        <section class="card"><div class="card-head"><h2>Why deliveries failed today</h2></div><div id="reasons"></div></section>
      </div>
      <section class="card"><div class="card-head"><h2>Open alerts in this region</h2></div><div class="alerts" id="ralerts"></div></section>`,
    load: (id) => apiGet(`/api/regions/${encodeURIComponent(id)}`),
    update(d) {
      const r = d.region;
      $('#r-crumb').textContent = `${r.name} region`;
      $('#r-title').textContent = `${r.name}: which hubs and lanes need attention today?`;
      $('#r-sub').textContent = `Regional Manager view · ${r.manager} · ${r.sortHubName} · ${r.hubs} hubs (${r.deliveryHubs} with delivery associates) · sort cut-off ${r.cutoff}`;
      const k = d.kpis;
      $('#kpis').innerHTML = [
        kpiCard({ label: 'On-time delivery', value: k.otd.value, unit: '%', status: k.otd.status, foot: 'Target 95%' }),
        kpiCard({ label: 'Line-haul on-time departure', value: k.onTimeDeparture.value, unit: '%', status: k.onTimeDeparture.status, foot: 'Within 15 min of schedule' }),
        kpiCard({ label: 'Arrived before sort cut-off', value: k.beforeCutoff.value, unit: '%', status: k.beforeCutoff.status, foot: 'Inbound trips completed today' }),
        kpiCard({ label: 'Hub backlog', value: k.backlog.value, foot: 'Parcels past planned dispatch' }),
        kpiCard({ label: 'Alert resolution time', value: k.alertResolution.value, small: k.alertResolution.value == null ? '' : 'min', status: k.alertResolution.value == null ? 'neutral' : k.alertResolution.status, foot: 'Median · target under 30 min' }),
      ].join('');
      $('#lane-title').textContent = `Inbound line-haul to ${r.sortHubName} · ${d.inbound.length} trips on the road`;
      $('#lanes').innerHTML = laneBoard(d.inbound.slice(0, 10), d.clock.minute);
      $('#hub-count').textContent = `${d.hubs.length} delivery hubs`;
      $('#hubs').innerHTML = `<table><thead><tr><th>Hub</th><th>On-time</th><th>First-attempt</th><th>Delivered</th><th>Backlog</th><th>DAs behind</th><th>7-day</th></tr></thead><tbody>${d.hubs.slice(0, 15).map((h) => `<tr><td><a href="#/hub/${esc(h.id)}"><b>${esc(h.name)}</b></a></td><td class="num ${tClass(h.otdStatus)}"><b>${fmtPct(h.otd)}</b></td><td class="num">${fmtPct(h.fads)}</td><td class="num">${fmt(h.delivered)} / ${fmt(h.planned)}</td><td class="num">${fmt(h.backlog)}</td><td class="num">${h.dasBehind} of ${h.das}</td><td>${spark(h.spark)}</td></tr>`).join('')}</tbody></table>`;
      $('#vendors').innerHTML = vendorTable(d.vendors.filter((v) => !v.owned)) + '<p class="sub">Network-wide today. Vendors under 90% are flagged for escalation.</p>';
      $('#reasons').innerHTML = reasonsList(d.failureReasons);
      $('#ralerts').innerHTML = d.alerts.length ? d.alerts.map((a) => alertCard(a)).join('') : '<div class="empty">No open alerts in this region.</div>';
      const labels = d.trend.map((t) => t.week);
      if (!this.chart) {
        this.chart = lineChart($('#rtrend'), labels, [
          { label: 'On-time delivery %', data: d.trend.map((t) => t.otd), borderColor: COLORS.good, backgroundColor: COLORS.good, borderWidth: 3, tension: 0.25, pointRadius: 2 },
          { label: 'First-attempt success %', data: d.trend.map((t) => t.fads), borderColor: COLORS.warn, backgroundColor: COLORS.warn, borderWidth: 2, tension: 0.25, pointRadius: 2 },
          targetLine(labels.length, 95, 'OTD target 95%'),
        ], { tick: (v) => `${v}%` });
      } else { this.chart.data.datasets[0].data = d.trend.map((t) => t.otd); this.chart.data.datasets[1].data = d.trend.map((t) => t.fads); this.chart.update('none'); }
    },
  };

  function spark(vals) {
    if (!vals || !vals.length) return '';
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 76 + 2},${18 - ((v - min) / span) * 14}`).join(' ');
    const down = vals[vals.length - 1] < vals[0] - 0.5;
    return `<svg width="80" height="20" viewBox="0 0 80 20" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${down ? COLORS.bad : COLORS.good}" stroke-width="2"/></svg>`;
  }
  function reasonsList(reasons) {
    const entries = Object.entries(reasons || {}).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, e) => s + e[1], 0);
    if (!total) return '<div class="empty">No failed deliveries yet today.</div>';
    return entries.map(([k, v]) => `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(k)}</span><b class="num">${fmt(v)} · ${Math.round((v / total) * 100)}%</b></div><div class="bar" style="margin-top:4px"><div style="width:${(v / total) * 100}%;background:${COLORS.warn}"></div></div></div>`).join('');
  }
  function laneBoard(trips, now) {
    if (!trips.length) return '<div class="empty">No inbound trips on the road right now.</div>';
    const lo = Math.min(...trips.map((t) => Math.min(t.plannedDep, t.actualDep)), now) - 20;
    const hi = Math.max(...trips.map((t) => Math.max(t.eta, t.cutoff)), now) + 20;
    const X = (m) => ((m - lo) / (hi - lo)) * 100;
    const clockOf = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => clockOf(lo + p * (hi - lo)));
    const rows = trips.map((t) => {
      const c = healthColor(t.health);
      return `<div class="lane"><div><a href="#/trip/${esc(t.id)}"><b>${esc(t.vehicleId)}</b></a> · ${esc(t.from.replace(' Sorting Hub', ''))}<div class="tl-time">${t.owned ? 'Owned' : esc(t.vendor)} · ${fmt(t.parcels)} parcels</div></div>
        <div class="lane-track"><div class="lane-plan" style="left:${X(t.plannedDep)}%;width:${X(t.plannedArr) - X(t.plannedDep)}%"></div>
          <div class="lane-actual" style="left:${X(t.actualDep)}%;width:${Math.max(0.5, X(t.eta) - X(t.actualDep))}%;background:${c}"></div>
          <div class="lane-cutoff" style="left:${X(t.cutoff)}%" title="Sort cut-off"></div><div class="lane-now" style="left:${X(now)}%" title="Now"></div></div>
        <div>${pill(t.health, t.health === 'on_time' ? 'On time' : `${LABEL[t.health]} +${t.delayMin} min`)}<div class="tl-time">ETA ${esc(t.etaClock)}${t.missesCutoff ? ' · misses cut-off' : ''}</div></div></div>`;
    }).join('');
    return `<div class="lane"><div></div><div class="lane-axis">${ticks.map((x) => `<span>${x}</span>`).join('')}</div><div></div></div>${rows}`;
  }

  // ---- Hub ----
  views.hub = {
    depth: 2,
    mount: () => `
      <div class="page-head"><div><div class="crumbs"><a href="#/ceo">Network</a> › <a id="h-region-link" href="#/region/CHI">Region</a> › <span id="h-crumb">Hub</span></div></div></div>
      <section class="hub-hero" id="hero" aria-label="Shift progress"></section>
      <div class="row">
        <section class="card wide"><div class="card-head"><h2>Delivery associates · behind first</h2><span class="card-note" id="da-note"></span></div><div id="unassigned"></div><div id="das"></div></section>
        <section class="card"><div class="card-head"><h2>Needs action</h2></div><div class="alerts" id="halerts"></div></section>
      </div>
      <div class="row">
        <section class="card"><div class="card-head"><h2>Late inbound trucks for this region</h2></div><div id="inbound"></div></section>
        <section class="card"><div class="card-head"><h2>Failed deliveries today</h2></div><div id="hfail"></div></section>
      </div>`,
    load: (id) => apiGet(`/api/hubs/${encodeURIComponent(id)}`),
    update(d) {
      const h = d.hub, s = d.stats;
      $('#h-region-link').textContent = `${h.regionName} region`;
      $('#h-region-link').href = `#/region/${h.regionId}`;
      $('#h-crumb').textContent = h.name;
      const progress = s.planned ? Math.round((s.delivered / s.planned) * 100) : 0;
      $('#hero').innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline"><h1 style="color:#fff">${esc(h.name)}</h1><span class="sub">Hub Manager view · ${esc(h.id)}</span></div>
        ${h.counterOnly ? '<div class="sub">Counter-only hub: accepts parcels from senders, no delivery associates assigned.</div>' : `
        <div style="display:flex;justify-content:space-between;font-size:14px"><span class="sub" style="margin:0">Delivered today</span><b class="num">${fmt(s.delivered)} of ${fmt(s.planned)}</b></div>
        <div class="bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Shift progress"><div style="width:${progress}%"></div></div>
        <div class="hero-stats"><div><div class="k">On-time</div><div class="v num">${fmtPct(s.otd)}</div></div><div><div class="k">First-attempt</div><div class="v num">${fmtPct(s.fads)}</div></div><div><div class="k">Backlog</div><div class="v num">${fmt(s.backlog)}</div></div><div><div class="k">DAs behind</div><div class="v num">${s.dasBehind + s.dasAbsent} of ${s.dasTotal}</div></div></div>`}`;
      $('#da-note').textContent = d.das.length ? `${d.das.length} on roster` : '';
      $('#unassigned').innerHTML = s.unassigned ? `<div class="alert warning" style="margin-bottom:10px"><div class="alert-title">${fmt(s.unassigned)} stops unassigned because ${s.dasAbsent} DA${s.dasAbsent === 1 ? ' is' : 's are'} absent</div><div class="alert-actions"><button class="btn btn-primary" data-action="assign-unassigned" data-id="${esc(h.id)}">Assign to DAs on shift</button></div></div>` : '';
      $('#das').innerHTML = d.das.length ? d.das.map((a) => {
        const pctDone = a.planned ? ((a.done + a.failed) / a.planned) * 100 : 0;
        const c = a.status === 'on_track' ? COLORS.good : a.status === 'at_risk' ? COLORS.warn : COLORS.bad;
        const label = a.status === 'idle' ? `Idle ${a.idleMin} min` : a.status === 'absent' ? 'Absent' : LABEL[a.status];
        return `<div class="da-row"><div><b>${esc(a.name)}</b> ${pill(a.status, label)}<div class="tl-time">${esc(a.id)} · last ping ${esc(a.lastPing)}</div></div>
          <div><div class="bar"><div style="width:${pctDone}%;background:${c}"></div></div><div class="tl-time" style="margin-top:4px">${a.status === 'absent' ? 'Not on shift' : `${a.done + a.failed} of ${a.planned} stops · expected ${a.expected} by now · ${a.left} left`}</div></div>
          <div class="da-actions">${a.status === 'absent' ? '' : `<button class="btn" data-action="call-da" data-name="${esc(a.name)}">Call</button>${a.left > 4 && d.das.length > 1 ? `<button class="btn" data-action="reassign" data-id="${esc(a.id)}">Reassign stops</button>` : ''}`}</div></div>`;
      }).join('') : '<div class="empty">No delivery associates at this hub.</div>';
      $('#halerts').innerHTML = d.alerts.length ? d.alerts.map((a) => alertCard(a, { inHub: true })).join('') : '<div class="empty">Nothing needs action at this hub right now.</div>';
      $('#inbound').innerHTML = d.inbound.length ? d.inbound.map((t) => `<div class="da-row" style="grid-template-columns:1fr auto"><div><a href="#/trip/${esc(t.id)}"><b>${esc(t.vehicleId)}</b></a> · ${esc(t.from)}<div class="tl-time">ETA ${esc(t.etaClock)} · ${fmt(t.parcels)} parcels${t.missesCutoff ? ' · misses sort cut-off' : ''}</div></div><div>${pill(t.health, `${LABEL[t.health]} +${t.delayMin} min`)}</div></div>`).join('') : '<div class="empty">All inbound trucks for this region are on time.</div>';
      $('#hfail').innerHTML = reasonsList(s.reasons);
    },
  };

  // ---- Trip ----
  views.trip = {
    depth: 2,
    mount: () => `
      <div class="page-head"><div><div class="crumbs"><a href="#/ops">Live map</a> › <a id="t-region" href="#/ops">Region</a> › <span id="t-crumb">Trip</span></div><h1 id="t-title">Trip</h1><div class="chips" id="t-chips" style="margin-top:8px"></div></div>
        <div class="alert-actions"><button class="btn btn-primary" data-action="contact" id="t-contact">Call driver</button><button class="btn" data-action="copy-link">Share trip link</button></div></div>
      <section class="grid-kpi" id="kpis"></section>
      <div class="row">
        <section class="card wide"><div class="card-head"><h2>Route: planned vs driven</h2><span class="card-note">Dashed: planned · Solid: driven so far</span></div><div id="map" style="height:360px"></div></section>
        <section class="card"><div class="card-head"><h2>Milestones</h2></div><ol class="timeline" id="milestones"></ol></section>
      </div>
      <section class="card"><div class="card-head"><h2>Downstream impact</h2></div><div id="impact" style="font-size:14px;line-height:1.6"></div></section>`,
    afterMount() {
      if (!window.L) return;
      destroyMap();
      app.map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(app.map);
      app.mapLayers = { g: L.layerGroup().addTo(app.map) };
    },
    load: (id) => apiGet(`/api/trips/${encodeURIComponent(id)}`),
    update(d) {
      const t = d.trip, v = d.vehicle;
      $('#t-crumb').textContent = `Trip ${t.id}`;
      $('#t-region').textContent = `${t.to.name.replace(' Sorting Hub', '')} region`;
      $('#t-region').href = `#/region/${t.to.regionId}`;
      $('#t-title').textContent = `${v.id} · ${t.from.name} → ${t.to.name}`;
      $('#t-chips').innerHTML = `${t.status === 'arrived' ? pill('on_time', 'Arrived') : pill(t.health, t.health === 'on_time' ? 'On time' : `${LABEL[t.health]} · +${t.delayMin} min`)}<span class="chip">${v.owned ? 'Owned vehicle' : `Hired · ${esc(v.vendor)}`} · ${esc(v.type)}</span><span class="chip">Driver: ${esc(v.driver)}</span><span class="chip">${t.kind === 'intercity' ? 'Intercity line-haul' : 'Feeder trip'}</span>${t.stoppedNow ? '<span class="chip" style="background:#fdf0e1;color:#8a4b00">Stopped now</span>' : ''}${t.contacted ? '<span class="chip">Driver contacted</span>' : ''}`;
      $('#t-contact').dataset.id = t.id;
      $('#t-contact').disabled = t.status === 'arrived';
      $('#kpis').innerHTML = [
        kpiCard({ label: 'Planned arrival', value: null, foot: t.to.kind === 'sort' ? `Sort cut-off ${t.cutoff}` : '' }).replace('–', esc(t.plannedArr)),
        kpiCard({ label: t.status === 'arrived' ? 'Arrived' : 'Current ETA', value: null, status: t.health, foot: 'Rule-based ETA, refreshed every 5 s' }).replace('–', `<span class="${tClass(t.health)}">${esc(t.eta)}</span>`),
        kpiCard({ label: 'Distance left', value: t.milesLeft, small: `of ${t.miles} mi`, foot: `${t.progress}% of route done` }),
        kpiCard({ label: 'Load', value: t.parcels, small: 'parcels', foot: `Utilization ${t.utilization}% · capacity ${fmt(v.capacity)}` }),
      ].join('');
      $('#milestones').innerHTML = d.milestones.map((m, i) => `<li><div class="tl-rail"><span class="tl-dot ${esc(m.status)}"></span>${i < d.milestones.length - 1 ? '<span class="tl-line"></span>' : ''}</div><div class="tl-body"><div class="tl-top"><span class="${m.status === 'pending' ? 'pending-label' : ''}">${esc(m.label)}</span><span class="tl-time">${esc(m.time)}</span></div><div class="tl-note">${m.planned ? `Planned ${esc(m.planned)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div></div></li>`).join('');
      $('#impact').innerHTML = t.missesCutoff
        ? `<b>${fmt(d.impact.parcels)} parcels</b> will miss the sort wave at ${esc(t.to.name)}. About ${d.impact.hubsAffected} destination hubs will see these parcels as at risk tomorrow.${d.sampleParcel ? ` <a href="#/parcel/${esc(d.sampleParcel)}">Open an affected parcel</a>` : ''}`
        : `${fmt(d.impact.parcels)} parcels on board. The trip is expected to make the sort cut-off, so no downstream impact.${d.sampleParcel ? ` <a href="#/parcel/${esc(d.sampleParcel)}">Open a parcel on this trip</a>` : ''}`;
      if (app.map && window.L) {
        const g = app.mapLayers.g; g.clearLayers();
        const from = [t.from.lat, t.from.lng], to = [t.to.lat, t.to.lng], now = [v.lat, v.lng];
        L.polyline([from, to], { color: '#5b6470', weight: 3, dashArray: '8 6' }).addTo(g);
        L.polyline([from, now], { color: COLORS.good, weight: 5 }).addTo(g);
        L.marker(from, { icon: L.divIcon({ className: '', html: '<div class="sort-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).bindTooltip(esc(t.from.name), { permanent: true, direction: 'top' }).addTo(g);
        L.marker(to, { icon: L.divIcon({ className: '', html: '<div class="sort-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).bindTooltip(esc(t.to.name), { permanent: true, direction: 'bottom' }).addTo(g);
        L.marker(now, { icon: vehicleIcon({ health: t.health }) }).bindTooltip(`${esc(v.id)} · ${t.milesLeft} mi to go`, { permanent: true, direction: 'right', offset: [8, 0] }).addTo(g);
        if (!this.fitted) { app.map.fitBounds(L.latLngBounds([from, to]).pad(0.3)); this.fitted = true; }
      }
    },
  };

  // ---- Parcel ----
  views.parcel = {
    depth: 3,
    mount: (id) => `
      <div class="page-head"><div><div class="crumbs">Parcels</div><h1>Parcel tracker</h1><div class="sub">Search any sample parcel to see its 7-event journey across intracity and intercity legs.</div></div></div>
      <form class="card" id="parcel-form" role="search" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <label class="field" style="flex:1 1 300px"><span>Tracking ID</span><input id="parcel-id" class="search-input" value="${esc(id || '')}" placeholder="ABC-1234-0001-US" style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:inherit;font-size:15px"></label>
        <button class="btn btn-primary" type="submit">Track</button>
        <div class="chips" id="samples" style="flex-basis:100%"></div>
      </form>
      <div id="parcel-body"></div>`,
    afterMount() {
      const meta = app.meta;
      $('#samples').innerHTML = '<span class="card-note">Try:</span> ' + meta.sampleParcels.map((p) => `<a class="chip" href="#/parcel/${esc(p)}">${esc(p)}</a>`).join('');
      $('#parcel-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#parcel-id').value.trim().toUpperCase(); if (v) location.hash = `#/parcel/${v}`; });
    },
    load: (id) => (id ? apiGet(`/api/parcels/${encodeURIComponent(id)}`).catch(() => ({ notFound: true, id })) : Promise.resolve(null)),
    update(d) {
      if (!d) { $('#parcel-body').innerHTML = ''; return; }
      if (d.notFound) { $('#parcel-body').innerHTML = `<div class="card empty">No parcel found for ${esc(d.id)}. Pick one of the sample IDs above.</div>`; return; }
      $('#parcel-body').innerHTML = `
        <section class="card" style="display:flex;flex-wrap:wrap;gap:20px;align-items:center"><div style="flex:1 1 240px"><div class="card-note">${esc(d.id)}</div><div class="kpi-value" style="font-size:22px">${esc(d.status)}</div>${d.reason ? `<div class="t-warn" style="font-size:13px">${esc(d.reason)}</div>` : ''}</div>
          <div class="compare" style="flex:2 1 420px;grid-template-columns:repeat(3,1fr)"><div><div class="l">From</div><b>${esc(d.from)}</b></div><div><div class="l">To</div><b>${esc(d.to)}</b></div><div><div class="l">Promised by</div><b>${esc(d.promised)}</b></div></div></section>
        <div class="row"><section class="card wide"><div class="card-head"><h2>Journey · 7 events</h2></div><ol class="timeline">${d.events.map((e, i) => `<li><div class="tl-rail"><span class="tl-dot ${esc(e.status)}"></span>${i < d.events.length - 1 ? '<span class="tl-line"></span>' : ''}</div><div class="tl-body"><div class="tl-top"><span class="${e.status === 'pending' ? 'pending-label' : ''}">${e.n} · ${esc(e.label)}</span><span class="tl-time">${esc(e.time)}</span></div><div class="tl-note">${esc([e.where, e.note].filter(Boolean).join(' · '))}</div></div></li>`).join('')}</ol></section>
          <aside class="card"><div class="card-head"><h2>Related</h2></div><div style="display:flex;flex-direction:column;gap:8px;font-size:14px"><a href="#/trip/${esc(d.tripId)}">Line-haul trip ${esc(d.tripId)}</a><a href="#/hub/${esc(d.destHubId)}">Destination hub ${esc(d.destHubId)}</a></div>
            <div class="card-head" style="margin-top:18px"><h2>Proof of delivery</h2></div><div class="empty" style="border:2px dashed var(--line);border-radius:8px;padding:24px;text-align:center">Photo, signature or OTP appears here once delivered.</div></aside></div>`;
    },
  };

  // ---- Alerts ----
  views.alerts = {
    depth: 1,
    mount: () => `
      <div class="page-head"><div><div class="crumbs">Alerts</div><h1>Alert inbox</h1><div class="sub">Alerts clear automatically when the condition clears. Unacknowledged alerts escalate after 30 and 60 minutes.</div></div>
        <div class="seg" role="group" aria-label="Severity"><button data-action="alert-filter" data-f="all">All</button><button data-action="alert-filter" data-f="critical">Critical</button><button data-action="alert-filter" data-f="warning">Warning</button></div></div>
      <div class="alerts" id="all-alerts"></div>`,
    load: () => apiGet('/api/alerts'),
    update(d) {
      const f = app.alertFilter;
      const list = d.alerts.filter((a) => f === 'all' || a.severity === f);
      $('#all-alerts').innerHTML = list.length ? list.map((a) => alertCard(a)).join('') : '<div class="card empty">No open alerts.</div>';
      document.querySelectorAll('[data-action="alert-filter"]').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
    },
  };

  // ---- Product KPIs ----
  views.product = {
    depth: 0,
    mount: () => `
      <div class="page-head"><div><div class="crumbs">Product</div><h1>Product engagement KPIs (weekly)</h1><div class="sub">How we know managers actually use the Control Tower. History is dummy data; the live panel counts what you do in this demo.</div></div></div>
      <section class="grid-kpi" id="kpis"></section>
      <div class="row"><section class="card wide"><div class="card-head"><h2>Last 8 weeks</h2></div><div class="chart-box"><canvas id="pchart"></canvas></div></section>
        <section class="card"><div class="card-head"><h2>Live in this demo session</h2></div><div id="live"></div></section></div>`,
    load: () => apiGet('/api/product-kpis'),
    update(d) {
      const last = d.history[d.history.length - 1], t = d.targets;
      const st = (v, tgt) => (v >= tgt ? 'good' : v >= tgt - 8 ? 'warn' : 'bad');
      $('#kpis').innerHTML = [
        kpiCard({ label: '1. Weekly active managers', value: last.wam, unit: '%', status: st(last.wam, t.wam), foot: `Target ${t.wam}% · users with a session this week` }),
        kpiCard({ label: '2. Alert action rate', value: last.alertActionRate, unit: '%', status: st(last.alertActionRate, t.alertActionRate), foot: `Target ${t.alertActionRate}% · alerts acknowledged or resolved in-product` }),
        kpiCard({ label: '3. Drill-down depth', value: last.drillDepth, unit: '%', status: st(last.drillDepth, t.drillDepth), foot: `Target ${t.drillDepth}% · sessions going 2+ levels deep` }),
      ].join('');
      if (!this.chart) {
        this.chart = lineChart($('#pchart'), d.history.map((h) => h.week), [
          { label: 'Weekly active managers %', data: d.history.map((h) => h.wam), borderColor: COLORS.good, backgroundColor: COLORS.good, borderWidth: 3, tension: 0.25 },
          { label: 'Alert action rate %', data: d.history.map((h) => h.alertActionRate), borderColor: COLORS.warn, backgroundColor: COLORS.warn, borderWidth: 2, tension: 0.25 },
          { label: 'Drill-down depth %', data: d.history.map((h) => h.drillDepth), borderColor: COLORS.ink, backgroundColor: COLORS.ink, borderWidth: 2, tension: 0.25, borderDash: [4, 3] },
        ], { min: 0, max: 100, tick: (v) => `${v}%` });
      }
      const l = d.live;
      $('#live').innerHTML = `<div class="compare" style="grid-template-columns:1fr auto"><div class="l">Screens viewed</div><b class="num">${l.viewsThisSession}</b><div class="l">Views 2+ levels deep</div><b class="num">${l.deepViewShare}%</b><div class="l">Alerts you acted on</div><b class="num">${l.alertsActedByUsers} of ${l.alertsRaisedToday}</b></div>
        <div class="card-head" style="margin-top:16px"><h2>Your recent actions</h2></div>${l.actions.length ? `<table><tbody>${l.actions.map((a) => `<tr><td class="tl-time">Day ${a.day} ${esc(a.at)}</td><td>${esc(a.type.replace(/_/g, ' '))}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Acknowledge an alert or reassign stops to see actions here.</div>'}`;
    },
  };

  // ---------------- router ----------------
  function parseHash() {
    const parts = (location.hash || '#/ceo').replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'ceo', id: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  async function route() {
    let r = parseHash();
    if (!views[r.name]) r = { name: 'ceo' };
    if (r.name === 'hub' && !r.id) { location.hash = `#/hub/${$('#hub-select').value}`; return; }
    if (r.name === 'region' && !r.id) { location.hash = `#/region/${$('#region-select').value}`; return; }
    if (r.name === 'trip' && !r.id) { location.hash = '#/ops'; return; }
    clearInterval(app.timer);
    destroyCharts(); destroyMap();
    app.route = r;
    const v = views[r.name];
    v.chart = null; v.fitted = false;
    app.view = v;
    document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name || (r.name === 'trip' && a.dataset.nav === 'ops')));
    syncSelectors(r);
    const el = $('#view');
    el.innerHTML = v.mount(r.id);
    if (v.afterMount) v.afterMount(r.id);
    el.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    apiPost('/api/events', { view: r.name, depth: v.depth }).catch(() => {});
    await refresh(true);
    app.timer = setInterval(() => refresh(false), REFRESH_MS);
  }

  async function refresh(first) {
    if (app.busy && !first) return;
    app.busy = true;
    const r = app.route, v = app.view;
    try {
      const data = await v.load(r.id);
      if (app.route !== r) return; // navigated away meanwhile
      if (data && data.error) throw new Error(data.error);
      v.update(data);
      if (data && data.clock) $('#clock-text').textContent = clockText(data.clock);
    } catch (e) {
      if (first) $('#view').insertAdjacentHTML('beforeend', `<div class="card empty">Could not load this view (${esc(e.message)}). Check the ID or try again.</div>`);
    } finally {
      app.busy = false;
    }
    apiGet('/api/alerts?severity=critical').then((a) => { $('#nav-alerts').textContent = a.alerts.length || ''; if (r.name !== 'ceo' && r.name !== 'ops' && a.clock) $('#clock-text').textContent = clockText(a.clock); }).catch(() => {});
  }

  // ---------------- top bar selectors ----------------
  function fillHubs(regionId, selected) {
    const hubs = app.meta.hubsByRegion[regionId] || [];
    $('#hub-select').innerHTML = hubs.map((h) => `<option value="${esc(h.id)}">${esc(h.name)} · ${h.das} DAs</option>`).join('');
    if (selected && hubs.some((h) => h.id === selected)) $('#hub-select').value = selected;
  }
  function syncSelectors(r) {
    const role = r.name === 'ceo' ? 'ceo' : r.name === 'ops' ? 'ops' : r.name === 'region' ? 'region' : r.name === 'hub' ? 'hub' : $('#role').value;
    $('#role').value = role;
    if (r.name === 'region' && r.id) { $('#region-select').value = r.id; fillHubs(r.id); }
    if (r.name === 'hub' && r.id) {
      const regionId = r.id.split('-')[0];
      if ($('#region-select').value !== regionId) { $('#region-select').value = regionId; }
      fillHubs(regionId, r.id);
      if ($('#hub-select').value !== r.id) { $('#hub-select').insertAdjacentHTML('afterbegin', `<option value="${esc(r.id)}">${esc(r.id)}</option>`); $('#hub-select').value = r.id; }
    }
    $('#region-field').style.display = role === 'region' || role === 'hub' ? '' : 'none';
    $('#hub-field').style.display = role === 'hub' ? '' : 'none';
    store.set('role', role);
  }

  function bindTopbar() {
    $('#region-select').innerHTML = app.meta.regions.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    $('#region-select').value = store.get('region', 'CHI');
    fillHubs($('#region-select').value);
    $('#role').addEventListener('change', (e) => {
      const role = e.target.value;
      location.hash = role === 'ceo' ? '#/ceo' : role === 'ops' ? '#/ops' : role === 'region' ? `#/region/${$('#region-select').value}` : `#/hub/${$('#hub-select').value}`;
    });
    $('#region-select').addEventListener('change', (e) => {
      store.set('region', e.target.value);
      fillHubs(e.target.value);
      location.hash = $('#role').value === 'hub' ? `#/hub/${$('#hub-select').value}` : `#/region/${e.target.value}`;
    });
    $('#hub-select').addEventListener('change', (e) => { location.hash = `#/hub/${e.target.value}`; });
    $('#search-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = $('#search').value.trim();
      if (!q) return;
      try {
        const r = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
        if (r.type === 'none') toast(`Nothing found for "${q}". Try a parcel ID, TRK-001, HIR-001, CHI-H001 or a region code like MIA.`);
        else { location.hash = r.link; $('#search').value = ''; }
      } catch (err) { toast('Search failed.'); }
    });
  }

  // ---------------- actions (event delegation) ----------------
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const act = b.dataset.action;
    try {
      if (act === 'filter') { app.filter = b.dataset.f; await refresh(true); return; }
      if (act === 'alert-filter') { app.alertFilter = b.dataset.f; await refresh(true); return; }
      if (act === 'copy-link') { await navigator.clipboard?.writeText(location.href).catch(() => {}); toast('Trip link copied.'); return; }
      if (act === 'call-da') { toast(`Calling ${b.dataset.name}… (demo: no real call is placed)`); return; }
      b.disabled = true;
      if (act === 'ack') { await apiPost(`/api/alerts/${encodeURIComponent(b.dataset.id)}/ack`); toast('Alert acknowledged. Escalation paused.'); }
      if (act === 'resolve') { await apiPost(`/api/alerts/${encodeURIComponent(b.dataset.id)}/resolve`); toast('Alert resolved.'); }
      if (act === 'reassign') { const r = await apiPost(`/api/das/${encodeURIComponent(b.dataset.id)}/reassign`); toast(r.message); }
      if (act === 'assign-unassigned') { const r = await apiPost(`/api/hubs/${encodeURIComponent(b.dataset.id)}/assign-unassigned`); toast(r.message); }
      if (act === 'contact') { const r = await apiPost(`/api/trips/${encodeURIComponent(b.dataset.id)}/contact`); toast(r.message); }
      await refresh(true);
    } catch (err) {
      toast('That action failed. Please try again.');
    } finally { b.disabled = false; }
  });

  // ---------------- boot ----------------
  async function boot() {
    try {
      app.meta = await apiGet('/api/meta');
    } catch (e) {
      $('#view').innerHTML = '<div class="card empty">Cannot reach the server API. Is the Node server running?</div>';
      return;
    }
    bindTopbar();
    window.addEventListener('hashchange', route);
    if (!location.hash) {
      const role = store.get('role', 'ceo');
      location.hash = role === 'ops' ? '#/ops' : role === 'region' ? `#/region/${$('#region-select').value}` : role === 'hub' ? `#/hub/${$('#hub-select').value}` : '#/ceo';
    } else route();
  }
  boot();
})();
