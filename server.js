'use strict';
const path = require('path');
const express = require('express');
const sim = require('./src/sim');
const api = require('./src/api');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

sim.start();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Simple optional basic-auth so a public EC2 demo isn't wide open.
const DEMO_USER = process.env.DEMO_USER;
const DEMO_PASS = process.env.DEMO_PASS;
if (DEMO_USER && DEMO_PASS) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const hdr = req.headers.authorization || '';
    const [user, pass] = Buffer.from(hdr.replace(/^Basic /, ''), 'base64').toString().split(':');
    if (user === DEMO_USER && pass === DEMO_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Control Tower demo"').status(401).send('Authentication required');
  });
}

const send = (res, data) => (data ? res.json(data) : res.status(404).json({ error: 'Not found' }));

app.get('/api/health', (req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()), clock: api.clock() }));
app.get('/api/meta', (req, res) => res.json(api.meta()));
app.get('/api/ceo', (req, res) => res.json(api.ceo()));
app.get('/api/ops', (req, res) => res.json(api.ops()));
app.get('/api/regions/:id', (req, res) => send(res, api.region(req.params.id.toUpperCase())));
app.get('/api/hubs/:id', (req, res) => send(res, api.hub(req.params.id.toUpperCase())));
app.get('/api/trips/:id', (req, res) => send(res, api.trip(req.params.id.toUpperCase())));
app.get('/api/parcels/:id', (req, res) => send(res, api.parcel(req.params.id.toUpperCase())));
app.get('/api/search', (req, res) => res.json(api.search(req.query.q)));
app.get('/api/alerts', (req, res) => {
  const { regionId, hubId, severity } = req.query;
  res.json({ clock: api.clock(), alerts: api.openAlerts((a) => (!regionId || a.regionId === regionId) && (!hubId || a.hubId === hubId) && (!severity || a.severity === severity), 200) });
});
app.post('/api/alerts/:id/ack', (req, res) => send(res, api.ackAlert(req.params.id, req.body?.by)));
app.post('/api/alerts/:id/resolve', (req, res) => send(res, api.resolveAlert(req.params.id, req.body?.by)));
app.post('/api/das/:id/reassign', (req, res) => send(res, api.reassignStops(req.params.id.toUpperCase())));
app.post('/api/hubs/:id/assign-unassigned', (req, res) => send(res, api.assignUnassigned(req.params.id.toUpperCase())));
app.post('/api/trips/:id/contact', (req, res) => send(res, api.contactDriver(req.params.id.toUpperCase())));
app.get('/api/product-kpis', (req, res) => res.json(api.productKpis()));
app.post('/api/events', (req, res) => { api.trackView(req.body?.view, req.body?.depth); res.status(204).end(); });

// Front-end libraries are served from node_modules so the demo has no CDN dependency.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(PORT, HOST, () => console.log(`Control Tower demo running on http://${HOST}:${PORT}`));
const shutdown = () => { sim.stop(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
