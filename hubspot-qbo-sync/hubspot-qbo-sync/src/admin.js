import express from 'express';
import { config } from './config.js';
import { db, audit } from './db.js';
import { safeEq } from './verify.js';
import { connectionStatus } from './qbo.js';
import { kick } from './worker.js';

export function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token') ?? req.query.token ?? '';
  return safeEq(t, config.adminToken) ? next() : res.status(401).send('Unauthorized');
}

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/api/status', (req, res) => res.json({ qbo: connectionStatus(), approvalThreshold: config.approvalThreshold }));
adminRouter.get('/api/events', (req, res) => res.json(db.prepare('SELECT * FROM sync_events ORDER BY id DESC LIMIT 100').all()));
adminRouter.get('/api/events/:id/audit', (req, res) => res.json(db.prepare('SELECT * FROM audit_log WHERE event_id = ? ORDER BY id').all(req.params.id)));

adminRouter.post('/events/:id/retry', (req, res) => {
  db.prepare(`UPDATE sync_events SET status='pending', next_attempt_at=0, attempts=0, updated_at=? WHERE id=? AND status IN ('failed','needs_review')`).run(Date.now(), req.params.id);
  audit(Number(req.params.id), 'admin', 'manual_retry'); kick(); res.json({ ok: true });
});
adminRouter.post('/events/:id/approve', (req, res) => {
  db.prepare(`UPDATE sync_events SET approved=1, status='pending', next_attempt_at=0, updated_at=? WHERE id=? AND status='needs_approval'`).run(Date.now(), req.params.id);
  audit(Number(req.params.id), 'admin', 'approved'); kick(); res.json({ ok: true });
});

adminRouter.get('/', (req, res) => res.type('html').send(PAGE));

const PAGE = `<!doctype html><meta charset="utf-8"><title>HubSpot → QuickBooks sync</title>
<style>
 body{font:14px system-ui;margin:24px;color:#1b1f24} h1{font-size:18px;margin:0 0 4px}
 .banner{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600}
 .sandbox{background:#fff3cd}.production{background:#f8d7da}
 table{border-collapse:collapse;width:100%;margin-top:16px} td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
 .s{padding:1px 6px;border-radius:10px;font-size:12px;background:#eee}
 .succeeded{background:#d4edda}.failed{background:#fff3cd}.needs_review,.needs_approval{background:#f8d7da}.processing,.pending{background:#d6e9ff}
 button{margin-right:4px} pre{white-space:pre-wrap;margin:4px 0;font-size:12px}
</style>
<h1>HubSpot → QuickBooks sync</h1><div id="status"></div><table><thead><tr>
<th>#</th><th>Deal</th><th>Amount</th><th>Status</th><th>Tries</th><th>QBO invoice</th><th>Last error</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<script>
const token = new URLSearchParams(location.search).get('token');
const H = { 'x-admin-token': token };
const el = (t, props = {}, ...kids) => { const e = Object.assign(document.createElement(t), props); kids.forEach(k => e.append(k)); return e; };
async function act(path) { await fetch(path, { method: 'POST', headers: H }); load(); }
async function showAudit(id, cell) {
  const rows = await (await fetch('/admin/api/events/' + id + '/audit', { headers: H })).json();
  cell.replaceChildren(...rows.map(r => el('pre', { textContent: new Date(r.at).toLocaleTimeString() + '  ' + r.actor + '  ' + r.action + '  ' + (r.detail || '') })));
}
async function load() {
  const st = await (await fetch('/admin/api/status', { headers: H })).json();
  document.getElementById('status').replaceChildren(
    el('span', { className: 'banner ' + st.qbo.env, textContent: 'QuickBooks: ' + st.qbo.env.toUpperCase() }),
    el('span', { textContent: st.qbo.connected ? '  connected (realm ' + st.qbo.realmId + ')' : '  NOT CONNECTED' }));
  const ev = await (await fetch('/admin/api/events', { headers: H })).json();
  document.getElementById('rows').replaceChildren(...ev.flatMap(e => {
    const auditCell = el('td', { colSpan: 8 });
    const btns = el('td');
    if (['failed', 'needs_review'].includes(e.status)) btns.append(el('button', { textContent: 'Retry', onclick: () => act('/admin/events/' + e.id + '/retry') }));
    if (e.status === 'needs_approval') btns.append(el('button', { textContent: 'Approve', onclick: () => act('/admin/events/' + e.id + '/approve') }));
    btns.append(el('button', { textContent: 'History', onclick: () => showAudit(e.id, auditCell) }));
    return [el('tr', {}, el('td', { textContent: e.id }), el('td', { textContent: (e.deal_name || '') + ' (' + e.hubspot_deal_id + ')' }),
      el('td', { textContent: e.amount ?? '' }), el('td', {}, el('span', { className: 's ' + e.status, textContent: e.status })),
      el('td', { textContent: e.attempts }), el('td', { textContent: e.qbo_invoice_id || '' }), el('td', { textContent: e.last_error || '' }), btns),
      el('tr', {}, auditCell)];
  }));
}
load(); setInterval(load, 5000);
</script>`;
