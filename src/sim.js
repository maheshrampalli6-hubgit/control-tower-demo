'use strict';
/**
 * ABC Inc. Delivery Control Tower — in-memory simulator.
 *
 * Generates a realistic-looking (but entirely fictional) parcel network:
 *   16 regions / sorting hubs, 1,000 hubs, 1,000 delivery associates (DAs),
 *   200 vehicles (100 owned, 100 hired), live line-haul trips, alerts and history.
 *
 * A simulated clock advances SIM_MINUTES_PER_TICK every TICK_MS of real time.
 * One operating day runs 06:00 → 22:00 and then rolls over into history.
 */

const TICK_MS = Number(process.env.TICK_MS || 5000);
const SIM_MINUTES_PER_TICK = Number(process.env.SIM_MINUTES_PER_TICK || 2);
const DAY_START = 6 * 60;       // 06:00 hubs open
const WINDOW_START = 8 * 60;    // 08:00 deliveries start
const WINDOW_END = 20 * 60;     // 20:00 delivery window closes
const DAY_END = 22 * 60;        // 22:00 day closes, roll over
const SEED = Number(process.env.SEED || 20261112);

// ---------- deterministic random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(SEED);
const rnd = (min, max) => min + rand() * (max - min);
const rint = (min, max) => Math.floor(rnd(min, max + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function haversineMiles(a, b) {
  const R = 3958.8, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- static master data ----------
const REGION_DEFS = [
  ['NYC', 'New York', 40.7128, -74.006, 0.962],
  ['BOS', 'Boston', 42.3601, -71.0589, 0.966],
  ['PHL', 'Philadelphia', 39.9526, -75.1652, 0.955],
  ['CLT', 'Charlotte', 35.2271, -80.8431, 0.96],
  ['ATL', 'Atlanta', 33.749, -84.388, 0.935],
  ['MIA', 'Miami', 25.7617, -80.1918, 0.912],
  ['DET', 'Detroit', 42.3314, -83.0458, 0.94],
  ['CHI', 'Chicago', 41.8781, -87.6298, 0.895],
  ['MSP', 'Minneapolis', 44.9778, -93.265, 0.958],
  ['DAL', 'Dallas', 32.7767, -96.797, 0.952],
  ['HOU', 'Houston', 29.7604, -95.3698, 0.958],
  ['DEN', 'Denver', 39.7392, -104.9903, 0.953],
  ['PHX', 'Phoenix', 33.4484, -112.074, 0.964],
  ['LAX', 'Los Angeles', 34.0522, -118.2437, 0.956],
  ['SFO', 'San Francisco', 37.7749, -122.4194, 0.951],
  ['SEA', 'Seattle', 47.6062, -122.3321, 0.95],
];
const FIRST = ['Marcus', 'Priya', 'Diego', 'Aisha', 'Kevin', 'Sofia', 'James', 'Mei', 'Omar', 'Hannah', 'Luis', 'Grace', 'Andre', 'Nina', 'Tyler', 'Fatima', 'Ryan', 'Elena', 'Jamal', 'Chloe', 'Victor', 'Maya', 'Derek', 'Leah', 'Carlos', 'Zoe', 'Ethan', 'Aaliyah', 'Noah', 'Isabel'];
const LAST = ['T.', 'S.', 'R.', 'K.', 'L.', 'M.', 'P.', 'W.', 'B.', 'G.', 'H.', 'D.', 'C.', 'N.', 'J.', 'F.'];
const VENDORS = ['Vendor A', 'Vendor B', 'Vendor C', 'Vendor D', 'Vendor E'];
const VENDOR_RELIABILITY = { 'Vendor A': 1.0, 'Vendor B': 2.4, 'Vendor C': 1.4, 'Vendor D': 1.2, 'Vendor E': 1.7 };
const FAIL_REASONS = ['Customer not home', 'Address not found', 'Refused', 'Damaged', 'Access restricted'];
const FAIL_WEIGHTS = [0.56, 0.22, 0.1, 0.06, 0.06];

const state = {
  startedAt: new Date().toISOString(),
  day: 1,
  simMinute: 10 * 60 + 30, // start mid-morning so the demo has data on first load
  tick: 0,
  regions: [],
  regionById: {},
  hubs: [],
  hubById: {},
  das: [],
  daById: {},
  vehicles: [],
  vehicleById: {},
  trips: {},           // active + recently completed trips by id
  completedTrips: [],  // today's completed trips (for on-time metrics)
  lanes: [],
  alerts: {},          // by id
  actions: [],         // user actions log
  history: {},         // regionId -> [{week, otd, fads, cpp, volume}]
  dailyHistory: [],    // network level, one per completed sim day
  parcels: {},         // sample parcels by id
  sessions: [],        // product usage events
  tripSeq: 1000,
};

function failReason() {
  let r = rand(), acc = 0;
  for (let i = 0; i < FAIL_REASONS.length; i++) { acc += FAIL_WEIGHTS[i]; if (r <= acc) return FAIL_REASONS[i]; }
  return FAIL_REASONS[0];
}

function fmtClock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// ---------- generation ----------
function generate() {
  rand = mulberry32(SEED);

  // Regions
  state.regions = REGION_DEFS.map(([id, name, lat, lng, quality], i) => ({
    id, name, lat, lng, quality,
    sortHubId: `${id}-SORT`,
    sortHubName: `${name} Sorting Hub`,
    cutoff: 23 * 60, // nightly sort cut-off 23:00
    costBase: round(rnd(8.6, 9.6), 2),
    manager: `${pick(FIRST)} ${pick(LAST)}`,
    hubIds: [],
  }));
  state.regions.forEach((r) => (state.regionById[r.id] = r));

  // Lanes: connect each sorting hub to its 3 nearest neighbours
  const laneSet = new Set();
  state.regions.forEach((a) => {
    state.regions
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, d: haversineMiles(a, b) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
      .forEach(({ b, d }) => {
        const key = [a.id, b.id].sort().join('-');
        if (!laneSet.has(key)) { laneSet.add(key); state.lanes.push({ id: key, a: a.id, b: b.id, miles: Math.round(d) }); }
      });
  });

  // Hubs: 1,000 spread across 16 regions (first 8 get 63, rest 62)
  let hubCount = 0;
  state.regions.forEach((r, ri) => {
    const n = ri < 8 ? 63 : 62;
    for (let i = 1; i <= n; i++) {
      hubCount++;
      const hub = {
        id: `${r.id}-H${pad(i, 3)}`,
        name: `${r.name} Hub ${pad(i)}`,
        regionId: r.id,
        lat: r.lat + rnd(-0.55, 0.55),
        lng: r.lng + rnd(-0.7, 0.7),
        quality: clamp(r.quality + rnd(-0.035, 0.03), 0.8, 0.99),
        fadsBase: clamp(r.quality + rnd(-0.04, 0.03), 0.82, 0.985),
        size: rand() < 0.5 ? 0 : 0.3 + rand() ** 3 * 7, // ~50% are counter-only acceptance points; a few big urban hubs
        daIds: [],
        unassigned: 0,
      };
      state.hubs.push(hub);
      state.hubById[hub.id] = hub;
      r.hubIds.push(hub.id);
    }
  });

  // DAs: 1,000, assigned to hubs weighted by size (counter-only hubs get none)
  const weighted = state.hubs.filter((h) => h.size > 0);
  const totalW = weighted.reduce((s, h) => s + h.size, 0);
  for (let i = 1; i <= 1000; i++) {
    let x = rand() * totalW, hub = weighted[0];
    for (const h of weighted) { x -= h.size; if (x <= 0) { hub = h; break; } }
    const da = {
      id: `DA-${pad(i, 4)}`,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      hubId: hub.id,
      regionId: hub.regionId,
      speed: rand() < 0.1 ? rnd(0.62, 0.78) : rnd(0.9, 1.15),
      absent: false,
      idleUntil: 0,
      lat: hub.lat, lng: hub.lng,
    };
    state.das.push(da);
    state.daById[da.id] = da;
    hub.daIds.push(da.id);
  }
  // Make sure every non-counter hub has at least one DA by moving from the largest hubs
  state.hubs.filter((h) => h.size > 0 && h.daIds.length === 0).forEach((h) => {
    const donor = [...state.hubs].sort((a, b) => b.daIds.length - a.daIds.length)[0];
    const daId = donor.daIds.pop();
    const da = state.daById[daId];
    da.hubId = h.id; da.regionId = h.regionId; da.lat = h.lat; da.lng = h.lng;
    h.daIds.push(daId);
  });

  // Vehicles: 100 owned, 100 hired
  for (let i = 1; i <= 200; i++) {
    const owned = i <= 100;
    const home = state.regions[(i - 1) % 16];
    const v = {
      id: owned ? `TRK-${pad(i, 3)}` : `HIR-${pad(i - 100, 3)}`,
      owned,
      vendor: owned ? 'ABC Fleet' : VENDORS[(i - 101) % VENDORS.length],
      type: owned ? (rand() < 0.6 ? '26 ft box truck' : '53 ft trailer') : (rand() < 0.5 ? '26 ft box truck' : '53 ft trailer'),
      capacity: owned ? rint(1300, 1800) : rint(1100, 1600),
      driver: `${pick(FIRST)} ${pick(LAST)}`,
      costPerMile: owned ? round(rnd(1.95, 2.25), 2) : round(rnd(2.45, 2.9), 2),
      lat: home.lat, lng: home.lng,
      locationRegion: home.id,
      tripId: null,
      waitTicks: 0,
      lastPingMin: 0,
    };
    state.vehicles.push(v);
    state.vehicleById[v.id] = v;
  }

  // 12 weeks of regional history
  state.regions.forEach((r) => {
    state.history[r.id] = [];
    for (let w = 12; w >= 1; w--) {
      const drift = r.id === 'CHI' || r.id === 'MIA' ? (12 - w) * -0.0035 : rnd(-0.004, 0.004);
      const otd = clamp(r.quality + 0.008 + drift + rnd(-0.006, 0.006), 0.8, 0.995);
      state.history[r.id].push({
        week: `W${46 - w}`,
        otd: round(otd * 100, 1),
        fads: round(clamp(otd - rnd(0.0, 0.03), 0.8, 0.99) * 100, 1),
        costPerParcel: round(r.costBase + (0.95 - otd) * 6 + rnd(-0.1, 0.1), 2),
        volume: Math.round(r.hubIds.length * rnd(380, 460)),
      });
    }
  });

  startDay(true);
}

function startDay(initial = false) {
  // Reset per-day counters on hubs & DAs
  state.das.forEach((da) => {
    const hub = state.hubById[da.hubId];
    da.planned = rint(48, 92);
    da.done = 0;
    da.failed = 0;
    da.onTime = 0;
    da.reasons = {};
    da.absent = rand() < 0.025;
    da.idleUntil = 0;
    da.lastPing = state.simMinute;
    da.lat = hub.lat; da.lng = hub.lng;
  });
  state.hubs.forEach((h) => { h.unassigned = 0; h.damaged = 0; });
  state.completedTrips = [];
  // Absent DAs leave their stops unassigned at the hub
  state.das.filter((d) => d.absent).forEach((d) => { state.hubById[d.hubId].unassigned += d.planned; d.planned = 0; });

  if (initial) {
    // Fast-forward DAs to the current sim minute so numbers look mid-day
    const ticks = Math.max(0, Math.floor((state.simMinute - WINDOW_START) / SIM_MINUTES_PER_TICK));
    for (let t = 0; t < ticks; t++) stepDAs(WINDOW_START + t * SIM_MINUTES_PER_TICK, true);
    // Seed some completed trips so line-haul metrics have a base
    for (let i = 0; i < 60; i++) {
      const v = pick(state.vehicles);
      const delay = v.owned ? rnd(-15, 26) : rnd(-12, 34) * (VENDOR_RELIABILITY[v.vendor] / 1.4);
      state.completedTrips.push({ vehicleId: v.id, owned: v.owned, vendor: v.vendor, regionId: pick(state.regions).id, depDelay: Math.max(0, delay * 0.5), arrDelay: delay, metCutoff: delay <= 30, toSort: true });
    }
  }
  // Start trips for every vehicle with random progress
  state.vehicles.forEach((v) => { v.tripId = null; v.waitTicks = 0; startTrip(v, initial ? rnd(0.05, 0.9) : 0); });
  generateParcels();
}

function startTrip(v, initialProgress = 0) {
  const here = state.regionById[v.locationRegion];
  let from, to, kind, miles;
  if (rand() < 0.62) {
    // intercity: sorting hub → neighbouring sorting hub
    const lanes = state.lanes.filter((l) => l.a === here.id || l.b === here.id);
    const lane = pick(lanes);
    const dest = state.regionById[lane.a === here.id ? lane.b : lane.a];
    from = { id: here.sortHubId, name: here.sortHubName, lat: here.lat, lng: here.lng, regionId: here.id, kind: 'sort' };
    to = { id: dest.sortHubId, name: dest.sortHubName, lat: dest.lat, lng: dest.lng, regionId: dest.id, kind: 'sort' };
    kind = 'intercity';
    miles = lane.miles;
  } else {
    // feeder: hub → sorting hub (inbound to sort) within the region
    const hub = state.hubById[pick(here.hubIds)];
    from = { id: hub.id, name: hub.name, lat: hub.lat, lng: hub.lng, regionId: here.id, kind: 'hub' };
    to = { id: here.sortHubId, name: here.sortHubName, lat: here.lat, lng: here.lng, regionId: here.id, kind: 'sort' };
    kind = 'feeder';
    miles = Math.max(8, Math.round(haversineMiles(from, to) * 1.25));
  }
  const mph = kind === 'intercity' ? 48 : 30;
  const duration = Math.max(20, (miles / mph) * 60);
  const reliability = v.owned ? 0.8 : VENDOR_RELIABILITY[v.vendor];
  const depDelay = Math.max(0, rnd(-10, 12) * reliability);
  const now = state.simMinute;
  const plannedDep = now - depDelay - initialProgress * duration;
  const id = `T-${++state.tripSeq}`;
  const trip = {
    id, vehicleId: v.id, kind, from, to, miles,
    duration,
    plannedDep,
    actualDep: plannedDep + depDelay,
    plannedArr: plannedDep + duration,
    cutoff: plannedDep + duration + 30,
    progress: initialProgress,
    stoppedTicks: 0,
    stopLog: [],
    parcels: Math.round(v.capacity * rnd(0.58, 0.95)),
    status: 'in_transit',
    contacted: false,
    path: [],
  };
  trip.utilization = round(trip.parcels / v.capacity * 100, 0);
  // occasional pre-existing incident for initial state realism
  if (initialProgress > 0 && rand() < 0.05 * reliability) {
    trip.stoppedTicks = rint(3, 14);
    trip.stopLog.push({ at: now - rint(5, 30), minutes: trip.stoppedTicks * SIM_MINUTES_PER_TICK, reason: pick(['Traffic congestion', 'Unplanned stop', 'Weather slowdown', 'Driver break overrun']) });
  }
  state.trips[id] = trip;
  v.tripId = id;
  computeTrip(trip);
}

function computeTrip(trip) {
  const remainingMin = (1 - trip.progress) * trip.duration + trip.stoppedTicks * SIM_MINUTES_PER_TICK;
  trip.eta = state.simMinute + remainingMin;
  trip.delayMin = Math.round(trip.eta - trip.plannedArr);
  trip.depDelayMin = Math.round(trip.actualDep - trip.plannedDep);
  trip.missesCutoff = trip.to.kind === 'sort' && trip.eta > trip.cutoff;
  trip.health = trip.delayMin > 30 ? 'delayed' : trip.delayMin > 15 ? 'at_risk' : 'on_time';
  trip.milesLeft = Math.round((1 - trip.progress) * trip.miles);
  const v = state.vehicleById[trip.vehicleId];
  const p = trip.progress;
  // slight curve so routes don't look like ruler lines
  const bend = Math.sin(p * Math.PI) * 0.35 * Math.min(1, trip.miles / 400);
  v.lat = trip.from.lat + (trip.to.lat - trip.from.lat) * p + bend * 0.3;
  v.lng = trip.from.lng + (trip.to.lng - trip.from.lng) * p - bend * 0.2;
}

function stepTrips() {
  state.vehicles.forEach((v) => {
    v.lastPingMin = v.owned ? 0 : (rand() < 0.1 ? rint(2, 9) : 0);
    if (!v.tripId) {
      if (--v.waitTicks <= 0) startTrip(v, 0);
      return;
    }
    const trip = state.trips[v.tripId];
    const reliability = v.owned ? 0.8 : VENDOR_RELIABILITY[v.vendor];
    if (trip.stoppedTicks > 0) {
      trip.stoppedTicks -= trip.contacted ? 2 : 1;
      if (trip.stoppedTicks < 0) trip.stoppedTicks = 0;
    } else {
      if (rand() < 0.0022 * reliability) {
        const ticks = rint(3, 14);
        trip.stoppedTicks = ticks;
        trip.contacted = false;
        trip.stopLog.push({ at: state.simMinute, minutes: ticks * SIM_MINUTES_PER_TICK, reason: pick(['Traffic congestion', 'Unplanned stop', 'Weather slowdown', 'Driver break overrun', 'Mechanical check']) });
      }
      trip.progress = Math.min(1, trip.progress + (SIM_MINUTES_PER_TICK / trip.duration) * rnd(0.85, 1.12));
    }
    computeTrip(trip);
    if (trip.progress >= 1) {
      trip.status = 'arrived';
      trip.actualArr = state.simMinute;
      state.completedTrips.push({ vehicleId: v.id, owned: v.owned, vendor: v.vendor, regionId: trip.to.regionId, depDelay: trip.depDelayMin, arrDelay: trip.delayMin, metCutoff: !trip.missesCutoff, toSort: trip.to.kind === 'sort' });
      v.locationRegion = trip.to.regionId;
      v.tripId = null;
      v.waitTicks = rint(2, 6);
      // keep finished trip for a while for lookups, then prune
      trip.finishedTick = state.tick;
    }
  });
  // prune old trips
  Object.values(state.trips).forEach((t) => { if (t.finishedTick && state.tick - t.finishedTick > 200) delete state.trips[t.id]; });
}

function stepDAs(minute, fast = false) {
  if (minute < WINDOW_START || minute >= WINDOW_END) return;
  const windowLen = WINDOW_END - WINDOW_START;
  state.das.forEach((da) => {
    if (da.absent || da.planned === 0) return;
    const hub = state.hubById[da.hubId];
    const attempted = da.done + da.failed;
    if (attempted >= da.planned) return;
    if (!fast && da.idleUntil > minute) return;
    if (!fast && rand() < 0.0025) { da.idleUntil = minute + rint(20, 55); return; }
    const rate = (da.planned / windowLen) * SIM_MINUTES_PER_TICK * da.speed;
    let attempts = Math.floor(rate) + (rand() < rate % 1 ? 1 : 0);
    attempts = Math.min(attempts, da.planned - attempted);
    for (let i = 0; i < attempts; i++) {
      if (rand() < hub.fadsBase) {
        da.done++;
        if (rand() < hub.quality / hub.fadsBase) da.onTime++;
      } else {
        da.failed++;
        const r = failReason();
        da.reasons[r] = (da.reasons[r] || 0) + 1;
        if (r === 'Damaged') hub.damaged++;
      }
    }
    da.lastPing = minute;
    da.lat = hub.lat + rnd(-0.05, 0.05);
    da.lng = hub.lng + rnd(-0.05, 0.05);
  });
}

// ---------- metrics helpers ----------
function windowFraction(minute = state.simMinute) {
  return clamp((minute - WINDOW_START) / (WINDOW_END - WINDOW_START), 0, 1);
}

function daStatus(da) {
  if (da.absent) return 'absent';
  const expected = da.planned * windowFraction();
  const attempted = da.done + da.failed;
  if (state.simMinute < da.idleUntil) return 'idle';
  if (expected < 3) return 'on_track';
  const ratio = attempted / expected;
  return ratio < 0.78 ? 'behind' : ratio < 0.9 ? 'at_risk' : 'on_track';
}

function hubStats(hub) {
  const das = hub.daIds.map((id) => state.daById[id]);
  const planned = das.reduce((s, d) => s + d.planned, 0) + hub.unassigned;
  const delivered = das.reduce((s, d) => s + d.done, 0);
  const failed = das.reduce((s, d) => s + d.failed, 0);
  const onTime = das.reduce((s, d) => s + d.onTime, 0);
  const attempted = delivered + failed;
  const expected = das.reduce((s, d) => s + d.planned * windowFraction(), 0);
  const backlog = Math.max(0, Math.round(expected - attempted)) + Math.round(hub.unassigned * windowFraction());
  const reasons = {};
  das.forEach((d) => Object.entries(d.reasons).forEach(([k, v]) => (reasons[k] = (reasons[k] || 0) + v)));
  const statuses = das.map(daStatus);
  return {
    planned, delivered, failed, onTime, attempted, backlog, reasons,
    otd: attempted ? onTime / attempted : null,
    fads: attempted ? delivered / attempted : null,
    dasTotal: das.length,
    dasBehind: statuses.filter((s) => s === 'behind' || s === 'idle').length,
    dasAtRisk: statuses.filter((s) => s === 'at_risk').length,
    dasAbsent: statuses.filter((s) => s === 'absent').length,
    unassigned: hub.unassigned,
    damaged: hub.damaged,
  };
}

function aggregate(hubs) {
  const acc = { planned: 0, delivered: 0, failed: 0, onTime: 0, attempted: 0, backlog: 0, reasons: {}, dasBehind: 0, damaged: 0 };
  hubs.forEach((h) => {
    const s = hubStats(h);
    ['planned', 'delivered', 'failed', 'onTime', 'attempted', 'backlog', 'dasBehind', 'damaged'].forEach((k) => (acc[k] += s[k]));
    Object.entries(s.reasons).forEach(([k, v]) => (acc.reasons[k] = (acc.reasons[k] || 0) + v));
  });
  acc.otd = acc.attempted ? acc.onTime / acc.attempted : null;
  acc.fads = acc.attempted ? acc.delivered / acc.attempted : null;
  acc.damageRate = acc.attempted ? acc.damaged / acc.attempted : 0;
  return acc;
}

function lineHaulStats(filter = () => true) {
  const done = state.completedTrips.filter(filter);
  const active = Object.values(state.trips).filter((t) => t.status === 'in_transit').filter((t) => filter({ ...t, owned: state.vehicleById[t.vehicleId].owned, vendor: state.vehicleById[t.vehicleId].vendor, regionId: t.to.regionId }));
  const depOnTime = [...done.map((t) => t.depDelay <= 15), ...active.map((t) => t.depDelayMin <= 15)];
  const toSort = done.filter((t) => t.toSort);
  return {
    completed: done.length,
    active: active.length,
    onTimeDeparture: depOnTime.length ? depOnTime.filter(Boolean).length / depOnTime.length : null,
    arrivedBeforeCutoff: toSort.length ? toSort.filter((t) => t.metCutoff).length / toSort.length : null,
    delayedNow: active.filter((t) => t.health === 'delayed').length,
    atRiskNow: active.filter((t) => t.health === 'at_risk').length,
  };
}

function regionCostPerParcel(region, otd) {
  return round(region.costBase + (0.95 - (otd ?? 0.95)) * 6, 2);
}

// ---------- alerts ----------
function upsertAlert(id, data) {
  const existing = state.alerts[id];
  if (existing && existing.status !== 'resolved') {
    Object.assign(existing, { detail: data.detail, title: data.title, severity: data.severity, lastSeen: state.simMinute });
    return;
  }
  if (existing && existing.status === 'resolved' && state.simMinute - existing.resolvedAt < 30) return; // avoid flapping
  state.alerts[id] = { id, ...data, status: 'open', raisedAt: state.simMinute, lastSeen: state.simMinute, escalation: 'Hub / Regional Manager' };
}

function evaluateAlerts() {
  const seen = new Set();
  // line-haul delays
  Object.values(state.trips).filter((t) => t.status === 'in_transit').forEach((t) => {
    const v = state.vehicleById[t.vehicleId];
    if (t.missesCutoff && t.to.kind === 'sort') {
      const id = `cutoff-${t.id}`; seen.add(id);
      upsertAlert(id, { type: 'cutoff', severity: 'critical', regionId: t.to.regionId, tripId: t.id, vehicleId: v.id,
        title: `${v.id} will miss ${state.regionById[t.to.regionId].name} sort cut-off`,
        detail: `${t.from.name} → ${t.to.name} · ETA ${fmtClock(t.eta)} vs cut-off ${fmtClock(t.cutoff)} · ${t.parcels.toLocaleString()} parcels` });
    } else if (t.delayMin > 30) {
      const id = `delay-${t.id}`; seen.add(id);
      upsertAlert(id, { type: 'delay', severity: 'critical', regionId: t.to.regionId, tripId: t.id, vehicleId: v.id,
        title: `${v.id} delayed +${t.delayMin} min`,
        detail: `${t.from.name} → ${t.to.name} · ${v.owned ? 'Owned' : v.vendor}` });
    }
  });
  // DAs idle / hubs with backlog
  state.hubs.forEach((h) => {
    if (!h.daIds.length) return;
    const s = hubStats(h);
    if (s.backlog > 120) {
      const id = `backlog-${h.id}`; seen.add(id);
      upsertAlert(id, { type: 'backlog', severity: s.backlog > 250 ? 'critical' : 'warning', regionId: h.regionId, hubId: h.id,
        title: `Backlog at ${h.name}: ${s.backlog} parcels`,
        detail: `${s.dasAbsent} DA absent · ${s.unassigned} stops unassigned · ${s.dasBehind} DAs behind plan` });
    }
    h.daIds.forEach((daId) => {
      const da = state.daById[daId];
      if (da.idleUntil > state.simMinute && state.simMinute - (da.idleUntil - 55) >= 0) {
        const idleFor = Math.round(state.simMinute - da.lastPing);
        if (idleFor >= 30) {
          const id = `idle-${da.id}`; seen.add(id);
          upsertAlert(id, { type: 'idle', severity: 'warning', regionId: h.regionId, hubId: h.id, daId: da.id,
            title: `${da.name} idle ${idleFor} min`,
            detail: `${h.name} · ${da.planned - da.done - da.failed} stops left · last ping ${fmtClock(da.lastPing)}` });
        }
      }
    });
  });
  // resolve cleared alerts, escalate stale open ones
  Object.values(state.alerts).forEach((a) => {
    if (a.status !== 'resolved' && !seen.has(a.id)) {
      a.status = 'resolved'; a.resolvedAt = state.simMinute; a.resolvedBy = a.resolvedBy || 'System (condition cleared)';
    }
    if (a.status === 'open') {
      const age = state.simMinute - a.raisedAt;
      a.escalation = age > 60 ? 'Operations Head' : age > 30 ? 'Regional Manager' : 'Hub / Regional Manager';
    }
  });
  // prune
  const resolved = Object.values(state.alerts).filter((a) => a.status === 'resolved').sort((a, b) => b.resolvedAt - a.resolvedAt);
  resolved.slice(300).forEach((a) => delete state.alerts[a.id]);
}

// ---------- sample parcels for the tracker ----------
function generateParcels() {
  state.parcels = {};
  const trips = Object.values(state.trips).filter((t) => t.kind === 'intercity');
  for (let i = 0; i < 300; i++) {
    const trip = trips[i % trips.length];
    const originRegion = state.regionById[trip.from.regionId];
    const destRegion = state.regionById[trip.to.regionId];
    const originHub = state.hubById[pick(originRegion.hubIds)];
    const destCandidates = destRegion.hubIds.filter((id) => state.hubById[id].daIds.length);
    const destHub = state.hubById[pick(destCandidates)];
    const id = `ABC-${pad(rint(1000, 9999), 4)}-${pad(i + 1, 4)}-US`;
    state.parcels[id] = { id, tripId: trip.id, originHubId: originHub.id, destHubId: destHub.id, pickupMin: trip.plannedDep - rint(180, 300), promisedDay: state.day + 1 };
  }
}

function parcelView(id) {
  const p = state.parcels[id];
  if (!p) return null;
  const trip = state.trips[p.tripId];
  const oh = state.hubById[p.originHubId], dh = state.hubById[p.destHubId];
  const ev = (n, label, where, time, status, note) => ({ n, label, where, time, status, note });
  const tripDone = !trip || trip.status === 'arrived';
  const tripHealth = trip ? trip.health : 'on_time';
  const events = [
    ev(1, 'Picked up from sender', oh.name, fmtClock(p.pickupMin), 'done', 'Intracity · first mile'),
    ev(2, 'Inscanned at origin hub', oh.name, fmtClock(p.pickupMin + 95), 'done', ''),
    ev(3, `Line-haul to ${trip ? trip.from.name : 'origin sorting hub'}`, 'Feeder trip', fmtClock(p.pickupMin + 150), 'done', 'On time'),
    ev(4, trip ? `Line-haul ${trip.from.name.replace(' Sorting Hub', '')} → ${trip.to.name.replace(' Sorting Hub', '')}` : 'Line-haul between sorting hubs', trip ? trip.vehicleId : '', trip ? (tripDone ? `Arrived ${fmtClock(trip.actualArr)}` : `ETA ${fmtClock(trip.eta)}`) : 'Arrived', tripDone ? 'done' : tripHealth === 'on_time' ? 'active' : tripHealth, trip && trip.missesCutoff ? 'Misses sort cut-off, moves to next wave' : ''),
    ev(5, 'Line-haul to destination hub', dh.name, tripDone ? 'In progress' : 'Expected next morning', tripDone ? 'active' : 'pending', ''),
    ev(6, 'Out for delivery', dh.name, 'Expected next day', 'pending', 'Intracity · last mile'),
    ev(7, 'Delivered with proof of delivery', '', 'Pending', 'pending', 'Photo, signature or OTP'),
  ];
  const atRisk = trip && trip.health !== 'on_time';
  return {
    id: p.id,
    status: atRisk ? (trip.health === 'delayed' ? 'In transit · Delayed' : 'In transit · At risk') : 'In transit · On time',
    health: atRisk ? trip.health : 'on_time',
    reason: trip && trip.missesCutoff ? `Missed sort wave because of a late line-haul (${trip.vehicleId})` : '',
    from: `${oh.name}, ${state.regionById[oh.regionId].name}`,
    to: `${dh.name}, ${state.regionById[dh.regionId].name}`,
    destHubId: dh.id,
    tripId: p.tripId,
    promised: `Day ${p.promisedDay}`,
    events,
  };
}

// ---------- main loop ----------
function tick() {
  state.tick++;
  state.simMinute += SIM_MINUTES_PER_TICK;
  if (state.simMinute >= DAY_END) {
    // roll the day into history
    const net = aggregate(state.hubs);
    state.dailyHistory.push({ day: state.day, otd: round((net.otd || 0) * 100, 1), fads: round((net.fads || 0) * 100, 1), delivered: net.delivered });
    if (state.dailyHistory.length > 30) state.dailyHistory.shift();
    state.day++;
    state.simMinute = DAY_START;
    startDay(false);
  }
  stepTrips();
  stepDAs(state.simMinute);
  evaluateAlerts();
}

let timer = null;
function start() {
  generate();
  evaluateAlerts();
  timer = setInterval(tick, TICK_MS);
  return state;
}
function stop() { if (timer) clearInterval(timer); }

module.exports = {
  state, start, stop, tick,
  helpers: { hubStats, aggregate, lineHaulStats, daStatus, regionCostPerParcel, fmtClock, windowFraction, parcelView, round, clamp },
  config: { TICK_MS, SIM_MINUTES_PER_TICK, WINDOW_START, WINDOW_END, DAY_START, DAY_END },
};
