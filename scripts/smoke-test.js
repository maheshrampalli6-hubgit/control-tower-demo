'use strict';
// Smoke test: hits every API endpoint of a running server and checks the basics.
// Usage: BASE_URL=http://localhost:3000 node scripts/smoke-test.js
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const auth = process.env.DEMO_USER ? { Authorization: 'Basic ' + Buffer.from(`${process.env.DEMO_USER}:${process.env.DEMO_PASS}`).toString('base64') } : {};

async function get(p) {
  const r = await fetch(BASE + p, { headers: auth });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
}
async function post(p) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`POST ${p} → HTTP ${r.status}`);
  return r.status === 204 ? {} : r.json();
}
const check = (cond, msg) => { if (!cond) throw new Error('Check failed: ' + msg); console.log('  ✓', msg); };

(async () => {
  console.log('Smoke test against', BASE);
  const health = await get('/api/health'); check(health.ok, 'health ok');
  const meta = await get('/api/meta');
  check(meta.counts.hubs === 1000 && meta.counts.das === 1000 && meta.counts.vehicles === 200, '1,000 hubs, 1,000 DAs, 200 vehicles');
  const ceo = await get('/api/ceo'); check(ceo.kpis.otd.value > 50 && ceo.regions.length === 16 && ceo.trend.length === 13, 'CEO view: KPIs, 16 regions, 13-point trend');
  const ops = await get('/api/ops'); check(ops.vehicles.length === 200 && ops.sortHubs.length === 16, 'Ops view: 200 vehicles, 16 sorting hubs');
  const reg = await get('/api/regions/CHI'); check(reg.hubs.length > 0 && Array.isArray(reg.inbound), `Region CHI: ${reg.hubs.length} delivery hubs, ${reg.inbound.length} inbound trips`);
  const hubId = meta.hubsByRegion.CHI[0].id;
  const hub = await get('/api/hubs/' + hubId); check(hub.das.length > 0, `Hub ${hubId}: ${hub.das.length} DAs`);
  const tripId = ops.vehicles.find((v) => v.tripId).tripId;
  const trip = await get('/api/trips/' + tripId); check(trip.milestones.length >= 4, `Trip ${tripId}: milestones`);
  const parcel = await get('/api/parcels/' + meta.sampleParcels[0]); check(parcel.events.length === 7, 'Parcel: 7 events');
  const s = await get('/api/search?q=' + ops.vehicles[0].id); check(s.type !== 'none', 'Search by vehicle');
  const alerts = await get('/api/alerts'); check(Array.isArray(alerts.alerts), `Alerts: ${alerts.alerts.length} open`);
  if (alerts.alerts[0]) { const a = await post(`/api/alerts/${alerts.alerts[0].id}/ack`); check(a.status === 'acknowledged' || a.status === 'resolved', 'Acknowledge alert'); }
  const r1 = await post(`/api/das/${hub.das[0].id}/reassign`); check(typeof r1.message === 'string', 'Reassign stops: ' + r1.message);
  const r2 = await post(`/api/trips/${tripId}/contact`); check(r2.ok, 'Contact driver');
  await post('/api/events');
  const pk = await get('/api/product-kpis'); check(pk.history.length === 8, 'Product KPIs');
  const html = await fetch(BASE + '/', { headers: auth }); check(html.ok && (await html.text()).includes('Control Tower'), 'Dashboard HTML served');
  console.log('All checks passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
