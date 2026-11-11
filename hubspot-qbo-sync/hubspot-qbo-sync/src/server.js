import crypto from 'node:crypto';
import express from 'express';
import { config, logger } from './config.js';
import { db, audit } from './db.js';
import { verifyWebhook } from './verify.js';
import { authorizeUrl, handleCallback } from './qbo.js';
import { startWorker, kick } from './worker.js';
import { adminRouter, requireAdmin } from './admin.js';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.json({ ok: true, qboEnv: config.qbo.env }));

/** Accepts both shapes: app-webhook subscription batches (array) and a workflow "send webhook" body (object).
 *  CONFIRM the exact shape against your first real delivery, then tighten this function. */
function extractDealIds(body) {
  const ids = new Set();
  if (Array.isArray(body)) {
    for (const e of body) {
      if (e.subscriptionType === 'deal.propertyChange' && e.propertyName === 'dealstage' && e.propertyValue === config.hubspot.closedWonStageId) ids.add(String(e.objectId));
    }
  } else {
    const id = body.object?.objectId ?? body.dealId ?? body.hs_object_id ?? body.properties?.hs_object_id?.value ?? body.properties?.hs_object_id;
    if (id) ids.add(String(id));
  }
  return [...ids];
}

function enqueue(dealId) {
  const key = `deal:${dealId}:closed-won`; // same deal + same transition => same row => processed once
  const now = Date.now();
  const r = db.prepare(`INSERT OR IGNORE INTO sync_events(idempotency_key, hubspot_deal_id, status, created_at, updated_at) VALUES (?,?, 'pending', ?, ?)`).run(key, dealId, now, now);
  const row = db.prepare('SELECT id, status FROM sync_events WHERE idempotency_key = ?').get(key);
  audit(row.id, 'webhook', r.changes ? 'received' : 'duplicate_ignored', { dealId });
  return { eventId: row.id, duplicate: !r.changes, status: row.status };
}

// RAW body: signature verification hashes the exact bytes HubSpot sent.
app.post('/webhooks/hubspot', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!verifyWebhook(req)) {
    logger.warn({ ip: req.ip }, 'webhook rejected: bad signature/token');
    return res.sendStatus(401);
  }
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (config.qbo.env === 'sandbox') logger.debug({ body }, 'webhook body'); // handy for learning the real payload shape
  const results = extractDealIds(body).map(enqueue);
  kick();
  res.status(200).json({ received: results.length, results }); // ack fast; work happens in the worker
});

// ---- QuickBooks OAuth ----
const states = new Map();
app.get('/auth/qbo/connect', requireAdmin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  res.redirect(authorizeUrl(state));
});
app.get('/auth/qbo/callback', async (req, res) => {
  const { code, state, realmId } = req.query;
  if (!states.delete(state)) return res.status(400).send('Invalid or expired state');
  try {
    await handleCallback(code, realmId);
    res.send(`QuickBooks (${config.qbo.env}) connected, realm ${realmId}. You can close this tab.`);
  } catch (e) {
    logger.error({ err: e.message }, 'OAuth callback failed');
    res.status(502).send('Could not complete QuickBooks authorization. Check server logs.');
  }
});

app.use('/admin', adminRouter);

app.listen(config.port, () => {
  logger.warn({ qbo: config.qbo.env, apiBase: config.qbo.apiBase, mockHubspot: config.mockHubspot }, `Listening on :${config.port}`);
  startWorker();
});
