'use strict';
/**
 * View-model builders: turn simulator state into the JSON each screen needs.
 * Every number is computed from the same helpers, so CEO, Ops Head, Regional
 * and Hub views always reconcile (one "metric dictionary").
 */
const sim = require('./sim');
const { state, helpers } = sim;
const { hubStats, aggregate, lineHaulStats, daStatus, regionCostPerParcel, fmtClock, windowFraction, parcelView, round } = helpers;

const TARGETS = { otd: 0.95, fads: 0.92, costPerParcel: 9.0, damage: 0.005, lineHaul: 0.95, alertMinutes: 30 };

const pct = (v, d = 1) => (v == null ? null : round(v * 100, d));
function status(value, target, warnBand, higherIsBetter = true) {
  if (value == null) return 'neutral';
  const diff = higherIsBetter ? value - target : target - value;
  if (diff >= 0) return 'good';
  return diff >= -warnBand ? 'warn' : 'bad';
}
const otdStatus = (v) => status(v, TARGETS.otd, 0.02);

function clock() {
  return { day: state.day, time: fmtClock(state.simMinute), minute: state.simMinute, windowProgress: round(windowFraction() * 100, 0), tick: state.tick };
}

function vendorStats() {
  const map = {};
  const add = (vendor, owned, depDelay, cpm) => {
    const k = owned ? 'ABC Fleet (owned)' : vendor;
    map[k] = map[k] || { vendor: k, owned, trips: 0, onTimeDep: 0, cpmSum: 0 };
    map[k].trips++; if (depDelay <= 15) map[k].onTimeDep++; map[k].cpmSum += cpm;
  };
  state.completedTrips.forEach((t) => add(t.vendor, t.owned, t.depDelay, state.vehicleById[t.vehicleId].costPerMile));
  Object.values(state.trips).filter((t) => t.status === 'in_transit').forEach((t) => { const v = state.vehicleById[t.vehicleId]; add(v.vendor, v.owned, t.depDelayMin, v.costPerMile); });
  return Object.values(map).map((m) => ({ vendor: m.vendor, owned: m.owned, trips: m.trips, onTimeDeparture: pct(m.onTimeDep / m.trips, 0), costPerMile: round(m.cpmSum / m.trips, 2), status: status(m.onTimeDep / m.trips, 0.95, 0.05) }))
    .sort((a, b) => (a.owned === b.owned ? a.onTimeDeparture - b.onTimeDeparture : a.owned ? -1 : 1));
}

function fleetCompare() {
  const res = {};
  [true, false].forEach((owned) => {
    const vs = state.vehicles.filter((v) => v.owned === owned);
    const lh = lineHaulStats((t) => t.owned === owned);
    const active = vs.map((v) => state.trips[v.tripId]).filter(Boolean);
    res[owned ? 'owned' : 'hired'] = {
      vehicles: vs.length,
      costPerMile: round(vs.reduce((s, v) => s + v.costPerMile, 0) / vs.length, 2),
      onTimeDeparture: pct(lh.onTimeDeparture, 0),
      utilization: round(active.reduce((s, t) => s + t.utilization, 0) / Math.max(1, active.length), 0),
      delayedNow: lh.delayedNow,
    };
  });
  return res;
}

function regionSummary(r) {
  const agg = aggregate(r.hubIds.map((id) => state.hubById[id]));
  const lh = lineHaulStats((t) => t.regionId === r.id);
  const openAlerts = Object.values(state.alerts).filter((a) => a.regionId === r.id && a.status !== 'resolved').length;
  return {
    id: r.id, name: r.name, manager: r.manager,
    hubs: r.hubIds.length,
    otd: pct(agg.otd), otdStatus: otdStatus(agg.otd),
    fads: pct(agg.fads),
    costPerParcel: regionCostPerParcel(r, agg.otd),
    backlog: agg.backlog,
    delivered: agg.delivered,
    lineHaulBeforeCutoff: pct(lh.arrivedBeforeCutoff, 0),
    onTimeDeparture: pct(lh.onTimeDeparture, 0),
    openAlerts,
    lat: r.lat, lng: r.lng,
  };
}

function networkTrend() {
  const weeks = state.history[state.regions[0].id].map((w) => w.week);
  const series = weeks.map((week, i) => {
    let vol = 0, otd = 0, cpp = 0;
    state.regions.forEach((r) => { const h = state.history[r.id][i]; vol += h.volume; otd += h.otd * h.volume; cpp += h.costPerParcel * h.volume; });
    return { label: week, otd: round(otd / vol, 1), costPerParcel: round(cpp / vol, 2), volume: vol };
  });
  const net = aggregate(state.hubs);
  series.push({ label: 'Today', otd: pct(net.otd), costPerParcel: networkCost(net), volume: net.delivered, live: true });
  return series;
}

function networkCost(net) {
  let sum = 0, vol = 0;
  state.regions.forEach((r) => { const a = aggregate(r.hubIds.map((id) => state.hubById[id])); sum += regionCostPerParcel(r, a.otd) * Math.max(1, a.attempted); vol += Math.max(1, a.attempted); });
  return round(sum / vol, 2);
}

function openAlerts(filter = () => true, limit = 50) {
  const sevRank = { critical: 0, warning: 1 };
  return Object.values(state.alerts)
    .filter((a) => a.status !== 'resolved')
    .filter(filter)
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.raisedAt - b.raisedAt)
    .slice(0, limit)
    .map(alertView);
}
function alertView(a) {
  return { ...a, age: Math.round(state.simMinute - a.raisedAt), raisedAtClock: fmtClock(a.raisedAt), regionName: state.regionById[a.regionId]?.name, hubName: a.hubId ? state.hubById[a.hubId].name : null };
}

// ---------------- screens ----------------
function ceo() {
  const net = aggregate(state.hubs);
  const plannedSoFar = Math.round(net.planned * windowFraction());
  const regions = state.regions.map(regionSummary);
  const cpp = networkCost(net);
  const trend = networkTrend();
  const lastWeek = trend[trend.length - 2];
  const fleet = fleetCompare();
  const vendors = vendorStats().filter((v) => !v.owned);
  const worst = [...regions].sort((a, b) => a.otd - b.otd)[0];
  const worstFads = [...regions].sort((a, b) => a.fads - b.fads)[0];
  const worstFadsReasons = aggregate(state.regionById[worstFads.id].hubIds.map((id) => state.hubById[id])).reasons;
  const topReason = Object.entries(worstFadsReasons).sort((a, b) => b[1] - a[1])[0];
  const worstVendor = vendors[0];
  const risks = [
    { regionId: worst.id, text: `${worst.name}: on-time delivery ${worst.otd}%, ${round(95 - worst.otd, 1)} pts below target. ${worst.lineHaulBeforeCutoff ?? '–'}% of inbound line-haul arrived before the sort cut-off.`, link: `#/region/${worst.id}` },
    { regionId: worstFads.id, text: `${worstFads.name}: first-attempt success ${worstFads.fads}%, mostly "${topReason ? topReason[0] : 'Customer not home'}".`, link: `#/region/${worstFads.id}` },
    worstVendor ? { text: `${worstVendor.vendor} (hired fleet): on-time departure ${worstVendor.onTimeDeparture}% across ${worstVendor.trips} trips today.`, link: '#/ops' } : null,
  ].filter(Boolean);
  return {
    clock: clock(),
    kpis: {
      otd: { value: pct(net.otd), target: 95, delta: round(pct(net.otd) - lastWeek.otd, 1), status: otdStatus(net.otd), unit: '%' },
      costPerParcel: { value: cpp, target: TARGETS.costPerParcel, delta: round(cpp - lastWeek.costPerParcel, 2), status: status(cpp, TARGETS.costPerParcel, 0.4, false), unit: '$' },
      volume: { value: net.delivered, plan: plannedSoFar, planDay: net.planned, pctOfPlan: plannedSoFar ? round((net.attempted / plannedSoFar) * 100, 0) : null, status: plannedSoFar && net.attempted / plannedSoFar < 0.95 ? 'warn' : 'good' },
      damage: { value: round(net.damageRate * 100, 2), target: 0.5, status: status(net.damageRate, TARGETS.damage, 0.002, false), unit: '%' },
    },
    trend,
    regions,
    fleet,
    risks,
  };
}

function ops() {
  const net = aggregate(state.hubs);
  const lh = lineHaulStats();
  const alerts = openAlerts();
  const critical = alerts.filter((a) => a.severity === 'critical');
  const ages = critical.map((a) => a.age).sort((a, b) => a - b);
  const vehicles = state.vehicles.map((v) => {
    const t = v.tripId ? state.trips[v.tripId] : null;
    return { id: v.id, owned: v.owned, vendor: v.vendor, lat: round(v.lat, 4), lng: round(v.lng, 4), health: t ? t.health : 'at_hub', tripId: t ? t.id : null, delayMin: t ? t.delayMin : 0, from: t ? t.from.name : null, to: t ? t.to.name : null, kind: t ? t.kind : null };
  });
  const delayed = vehicles.filter((v) => v.health === 'delayed');
  return {
    clock: clock(),
    kpis: {
      otd: { value: pct(net.otd), target: 95, status: otdStatus(net.otd) },
      lineHaulBeforeCutoff: { value: pct(lh.arrivedBeforeCutoff, 0), target: 95, status: status(lh.arrivedBeforeCutoff, 0.95, 0.04) },
      vehiclesDelayed: { value: delayed.length, total: vehicles.length, hired: delayed.filter((v) => !v.owned).length, owned: delayed.filter((v) => v.owned).length, status: delayed.length > 10 ? 'bad' : delayed.length > 4 ? 'warn' : 'good' },
      criticalAlerts: { value: critical.length, medianAge: ages.length ? ages[Math.floor(ages.length / 2)] : 0, status: critical.length > 8 ? 'bad' : critical.length > 3 ? 'warn' : 'good' },
    },
    vehicles,
    sortHubs: state.regions.map((r) => ({ id: r.sortHubId, regionId: r.id, name: r.sortHubName, lat: r.lat, lng: r.lng })),
    lanes: state.lanes.map((l) => ({ a: [state.regionById[l.a].lat, state.regionById[l.a].lng], b: [state.regionById[l.b].lat, state.regionById[l.b].lng] })),
    alerts: alerts.slice(0, 12),
    alertCounts: { critical: critical.length, warning: alerts.length - critical.length },
    leaderboard: state.regions.map(regionSummary).sort((a, b) => a.otd - b.otd),
    fleet: fleetCompare(),
    vendors: vendorStats(),
  };
}

function region(id) {
  const r = state.regionById[id];
  if (!r) return null;
  const summary = regionSummary(r);
  const inbound = Object.values(state.trips)
    .filter((t) => t.status === 'in_transit' && t.to.regionId === id && t.to.kind === 'sort')
    .sort((a, b) => b.delayMin - a.delayMin)
    .map((t) => {
      const v = state.vehicleById[t.vehicleId];
      return { id: t.id, vehicleId: v.id, owned: v.owned, vendor: v.vendor, from: t.from.name, kind: t.kind, plannedDep: t.plannedDep, actualDep: t.actualDep, plannedArr: t.plannedArr, eta: t.eta, cutoff: t.cutoff, delayMin: t.delayMin, health: t.health, missesCutoff: t.missesCutoff, parcels: t.parcels, etaClock: fmtClock(t.eta) };
    });
  const hubs = r.hubIds.map((hid) => state.hubById[hid]).filter((h) => h.daIds.length).map((h) => {
    const s = hubStats(h);
    return { id: h.id, name: h.name, otd: pct(s.otd), otdStatus: otdStatus(s.otd), fads: pct(s.fads), backlog: s.backlog, das: s.dasTotal, dasBehind: s.dasBehind + s.dasAbsent, delivered: s.delivered, planned: s.planned, spark: sparkFor(h) };
  }).sort((a, b) => (a.otd ?? 100) - (b.otd ?? 100));
  const agg = aggregate(r.hubIds.map((hid) => state.hubById[hid]));
  const regionAlerts = openAlerts((a) => a.regionId === id);
  const resolvedHere = Object.values(state.alerts).filter((a) => a.regionId === id && a.status === 'resolved' && a.resolvedAt);
  const resTimes = resolvedHere.map((a) => a.resolvedAt - a.raisedAt).sort((a, b) => a - b);
  return {
    clock: clock(),
    region: { id: r.id, name: r.name, manager: r.manager, sortHubName: r.sortHubName, hubs: r.hubIds.length, deliveryHubs: hubs.length, cutoff: fmtClock(r.cutoff) },
    kpis: {
      otd: { value: summary.otd, status: summary.otdStatus },
      onTimeDeparture: { value: summary.onTimeDeparture, status: status((summary.onTimeDeparture ?? 100) / 100, 0.95, 0.05) },
      beforeCutoff: { value: summary.lineHaulBeforeCutoff, status: status((summary.lineHaulBeforeCutoff ?? 100) / 100, 0.95, 0.04) },
      backlog: { value: agg.backlog },
      alertResolution: { value: resTimes.length ? Math.round(resTimes[Math.floor(resTimes.length / 2)]) : null, status: resTimes.length && resTimes[Math.floor(resTimes.length / 2)] > 30 ? 'warn' : 'good' },
    },
    inbound,
    hubs,
    vendors: vendorStats(),
    alerts: regionAlerts,
    failureReasons: agg.reasons,
    trend: state.history[id].concat([{ week: 'Today', otd: summary.otd, fads: summary.fads, costPerParcel: summary.costPerParcel }]),
  };
}

function sparkFor(h) {
  // 7-day sparkline derived deterministically from hub quality (dummy history)
  const base = h.quality * 100;
  let seed = h.id.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return Array.from({ length: 7 }, (_, i) => { seed = (seed * 9301 + 49297) % 233280; return round(base + (seed / 233280 - 0.5) * 3 - (h.quality < 0.9 ? i * 0.4 : 0), 1); });
}

function hub(id) {
  const h = state.hubById[id];
  if (!h) return null;
  const s = hubStats(h);
  const r = state.regionById[h.regionId];
  const das = h.daIds.map((daId) => {
    const d = state.daById[daId];
    const st = daStatus(d);
    return { id: d.id, name: d.name, status: st, planned: d.planned, done: d.done, failed: d.failed, left: Math.max(0, d.planned - d.done - d.failed), expected: Math.round(d.planned * windowFraction()), lastPing: fmtClock(d.lastPing), idleMin: st === 'idle' ? Math.round(state.simMinute - d.lastPing) : 0 };
  }).sort((a, b) => rank(a.status) - rank(b.status));
  const inbound = Object.values(state.trips)
    .filter((t) => t.status === 'in_transit' && t.to.regionId === h.regionId && t.to.kind === 'sort' && t.health !== 'on_time')
    .sort((a, b) => b.delayMin - a.delayMin).slice(0, 3)
    .map((t) => ({ id: t.id, vehicleId: t.vehicleId, from: t.from.name, etaClock: fmtClock(t.eta), delayMin: t.delayMin, health: t.health, parcels: t.parcels, missesCutoff: t.missesCutoff }));
  return {
    clock: clock(),
    hub: { id: h.id, name: h.name, regionId: h.regionId, regionName: r.name, lat: h.lat, lng: h.lng, counterOnly: h.daIds.length === 0 },
    stats: { ...s, otd: pct(s.otd), fads: pct(s.fads) },
    das,
    inbound,
    alerts: openAlerts((a) => a.hubId === id),
  };
}
const rank = (st) => ({ absent: 0, idle: 1, behind: 2, at_risk: 3, on_track: 4 }[st] ?? 5);

function trip(id) {
  const t = state.trips[id];
  if (!t) return null;
  const v = state.vehicleById[t.vehicleId];
  const milestones = [
    { label: 'Loaded and sealed', time: fmtClock(t.plannedDep - 25), planned: fmtClock(t.plannedDep - 25), status: 'done' },
    { label: t.depDelayMin > 15 ? 'Departed · At risk' : 'Departed', time: fmtClock(t.actualDep), planned: fmtClock(t.plannedDep), status: t.depDelayMin > 15 ? 'at_risk' : 'done', note: t.depDelayMin > 0 ? `+${t.depDelayMin} min vs plan` : 'on time' },
    ...t.stopLog.map((s) => ({ label: `${s.reason}, ${s.minutes} min`, time: fmtClock(s.at), status: 'at_risk', note: 'Unplanned stop' })),
    { label: t.status === 'arrived' ? `Arrived ${t.to.name}` : `Arrive ${t.to.name}${t.health === 'delayed' ? ' · Delayed' : ''}`, time: t.status === 'arrived' ? fmtClock(t.actualArr) : `ETA ${fmtClock(t.eta)}`, planned: fmtClock(t.plannedArr), status: t.status === 'arrived' ? 'done' : t.health === 'on_time' ? 'pending' : t.health, note: t.to.kind === 'sort' ? `Sort cut-off ${fmtClock(t.cutoff)}` : '' },
    { label: 'Unloaded and sorted', time: t.missesCutoff ? 'Next sort wave' : 'After arrival', status: 'pending' },
  ];
  const affectedHubs = t.to.kind === 'sort' ? Math.min(state.regionById[t.to.regionId].hubIds.length, Math.max(3, Math.round(t.parcels / 140))) : 1;
  return {
    clock: clock(),
    trip: { id: t.id, kind: t.kind, from: t.from, to: t.to, miles: t.miles, milesLeft: t.milesLeft, progress: round(t.progress * 100, 0), plannedArr: fmtClock(t.plannedArr), eta: fmtClock(t.eta), cutoff: fmtClock(t.cutoff), delayMin: t.delayMin, health: t.health, missesCutoff: t.missesCutoff, parcels: t.parcels, utilization: t.utilization, status: t.status, contacted: t.contacted, stoppedNow: t.stoppedTicks > 0 },
    vehicle: { id: v.id, owned: v.owned, vendor: v.vendor, type: v.type, driver: v.driver, lat: v.lat, lng: v.lng, capacity: v.capacity, costPerMile: v.costPerMile },
    milestones,
    impact: { parcels: t.parcels, hubsAffected: affectedHubs, missesCutoff: t.missesCutoff },
    sampleParcel: Object.values(state.parcels).find((p) => p.tripId === t.id)?.id || null,
  };
}

function search(q) {
  const s = String(q || '').trim().toUpperCase();
  if (!s) return { type: 'none' };
  if (state.parcels[s]) return { type: 'parcel', id: s, link: `#/parcel/${s}` };
  const v = state.vehicleById[s];
  if (v) return v.tripId ? { type: 'trip', id: v.tripId, link: `#/trip/${v.tripId}` } : { type: 'vehicle', id: v.id, link: '#/ops' };
  if (state.trips[s]) return { type: 'trip', id: s, link: `#/trip/${s}` };
  if (state.hubById[s]) return { type: 'hub', id: s, link: `#/hub/${s}` };
  if (state.regionById[s]) return { type: 'region', id: s, link: `#/region/${s}` };
  const hubByName = state.hubs.find((h) => h.name.toUpperCase() === s);
  if (hubByName) return { type: 'hub', id: hubByName.id, link: `#/hub/${hubByName.id}` };
  return { type: 'none' };
}

function meta() {
  const defaultHubs = {};
  state.regions.forEach((r) => {
    defaultHubs[r.id] = r.hubIds.map((id) => state.hubById[id]).filter((h) => h.daIds.length).sort((a, b) => b.daIds.length - a.daIds.length).slice(0, 12).map((h) => ({ id: h.id, name: h.name, das: h.daIds.length }));
  });
  return {
    clock: clock(),
    company: 'ABC Inc. (fictional demo data)',
    counts: { regions: state.regions.length, hubs: state.hubs.length, deliveryHubs: state.hubs.filter((h) => h.daIds.length).length, das: state.das.length, vehicles: state.vehicles.length, owned: state.vehicles.filter((v) => v.owned).length, hired: state.vehicles.filter((v) => !v.owned).length },
    regions: state.regions.map((r) => ({ id: r.id, name: r.name })),
    hubsByRegion: defaultHubs,
    sampleParcels: Object.keys(state.parcels).slice(0, 8),
    targets: TARGETS,
  };
}

// ---------------- actions ----------------
function logAction(type, detail) {
  state.actions.unshift({ type, detail, at: fmtClock(state.simMinute), day: state.day, ts: Date.now() });
  state.actions = state.actions.slice(0, 200);
}

function ackAlert(id, by = 'Demo user') {
  const a = state.alerts[id];
  if (!a) return null;
  if (a.status === 'open') { a.status = 'acknowledged'; a.ackAt = state.simMinute; a.ackBy = by; logAction('alert_ack', a.title); }
  return alertView(a);
}
function resolveAlert(id, by = 'Demo user') {
  const a = state.alerts[id];
  if (!a) return null;
  if (a.status !== 'resolved') { a.status = 'resolved'; a.resolvedAt = state.simMinute; a.resolvedBy = by; a.userResolved = true; logAction('alert_resolve', a.title); }
  return alertView(a);
}

function reassignStops(daId) {
  const da = state.daById[daId];
  if (!da) return null;
  const hub = state.hubById[da.hubId];
  const others = hub.daIds.map((id) => state.daById[id]).filter((d) => d.id !== da.id && !d.absent);
  let moved = 0;
  const left = Math.max(0, da.planned - da.done - da.failed);
  if (!others.length) return { ok: false, message: 'No other DA on shift at this hub to take the stops.' };
  const share = Math.ceil(left / 2);
  // move half of the remaining stops, spread across the other DAs
  for (let i = 0; i < share; i++) { others[i % others.length].planned++; da.planned--; moved++; }
  da.idleUntil = 0;
  logAction('reassign', `${moved} stops from ${da.name} at ${hub.name}`);
  return { ok: true, moved, message: `Moved ${moved} stops from ${da.name} to ${others.length} other DA${others.length > 1 ? 's' : ''}.` };
}

function assignUnassigned(hubId) {
  const hub = state.hubById[hubId];
  if (!hub) return null;
  const present = hub.daIds.map((id) => state.daById[id]).filter((d) => !d.absent);
  if (!present.length || !hub.unassigned) return { ok: false, message: hub.unassigned ? 'No DA on shift to take the stops.' : 'No unassigned stops.' };
  const n = hub.unassigned;
  for (let i = 0; i < n; i++) present[i % present.length].planned++;
  hub.unassigned = 0;
  logAction('assign_unassigned', `${n} stops at ${hub.name}`);
  return { ok: true, moved: n, message: `Assigned ${n} stops across ${present.length} DA${present.length > 1 ? 's' : ''}.` };
}

function contactDriver(tripId) {
  const t = state.trips[tripId];
  if (!t) return null;
  t.contacted = true;
  logAction('contact_driver', `${t.vehicleId} on ${t.id}`);
  return { ok: true, message: `Driver of ${t.vehicleId} contacted. Unplanned stop time will clear faster.` };
}

// ---------------- product KPIs (engagement) ----------------
function productKpis() {
  // 8 weeks of dummy history + live counts from this demo session
  const weeks = ['W38', 'W39', 'W40', 'W41', 'W42', 'W43', 'W44', 'W45'];
  const wam = [31, 38, 46, 52, 58, 61, 66, 69];
  const actionRate = [42, 51, 58, 63, 67, 72, 75, 78];
  const depth = [18, 22, 26, 29, 33, 35, 38, 41];
  const alertsAll = Object.values(state.alerts);
  const userActed = alertsAll.filter((a) => a.ackBy || a.userResolved).length;
  const views = state.sessions;
  const deepViews = views.filter((v) => v.depth >= 2).length;
  return {
    history: weeks.map((w, i) => ({ week: w, wam: wam[i], alertActionRate: actionRate[i], drillDepth: depth[i] })),
    targets: { wam: 70, alertActionRate: 80, drillDepth: 40 },
    live: {
      viewsThisSession: views.length,
      deepViewShare: views.length ? round((deepViews / views.length) * 100, 0) : 0,
      alertsActedByUsers: userActed,
      alertsRaisedToday: alertsAll.length,
      actions: state.actions.slice(0, 15),
    },
  };
}
function trackView(view, depth) {
  state.sessions.push({ view: String(view).slice(0, 40), depth: Number(depth) || 0, at: Date.now() });
  if (state.sessions.length > 2000) state.sessions.shift();
}

module.exports = { ceo, ops, region, hub, trip, parcel: parcelView, search, meta, openAlerts, ackAlert, resolveAlert, reassignStops, assignUnassigned, contactDriver, productKpis, trackView, clock };
