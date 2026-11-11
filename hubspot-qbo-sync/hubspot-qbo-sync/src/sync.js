import crypto from 'node:crypto';
import { config, logger } from './config.js';
import { db, audit } from './db.js';
import { getDealBundle } from './hubspot.js';
import { customerKey, buildCustomer, buildInvoice, parseAmount } from './mapping.js';
import { qbo, qboQuery } from './qbo.js';
import { PermanentError } from './errors.js';

// QBO's requestid must be short (<= 50 chars per Intuit-related docs: verify). Derive it from our idempotency key
// so a retry after a timeout hits the SAME request id and QBO can de-duplicate the write.
const requestId = (prefix, key) => `${prefix}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
const setStatus = (id, status, extra = {}) => {
  const cols = Object.keys(extra).map((k) => `, ${k} = @${k}`).join('');
  db.prepare(`UPDATE sync_events SET status = @status, updated_at = @now${cols} WHERE id = @id`).run({ id, status, now: Date.now(), ...extra });
};

async function findOrCreateCustomer(eventId, key, bundle) {
  const mapped = db.prepare('SELECT qbo_customer_id FROM customer_map WHERE hubspot_key = ?').get(key);
  if (mapped) return mapped.qbo_customer_id;

  const payload = buildCustomer(bundle);
  const esc = payload.DisplayName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // DisplayName is unique across QBO customers/vendors/employees, so it is the safest match key.
  // Note: inactive customers are not returned by default; creating a same-named one will fail (needs_review).
  const found = await qboQuery(`select Id, DisplayName from Customer where DisplayName = '${esc}'`);
  let id = found.Customer?.[0]?.Id;
  if (id) {
    audit(eventId, 'system', 'qbo_customer_matched', { id, by: 'DisplayName' });
  } else {
    const r = await qbo('POST', '/customer', { body: payload, requestId: requestId('cus', key) });
    id = r.Customer.Id;
    audit(eventId, 'system', 'qbo_customer_created', { id });
  }
  db.prepare('INSERT OR REPLACE INTO customer_map(hubspot_key, qbo_customer_id, created_at) VALUES (?,?,?)').run(key, id, Date.now());
  return id;
}

export async function processEvent(id) {
  // Atomic claim: only one worker can move a row into "processing".
  const claimed = db
    .prepare(`UPDATE sync_events SET status='processing', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('pending','failed')`)
    .run(Date.now(), id);
  if (!claimed.changes) return;
  const ev = db.prepare('SELECT * FROM sync_events WHERE id = ?').get(id);
  audit(id, 'system', 'attempt_started', { attempt: ev.attempts });

  try {
    if (ev.qbo_invoice_id) return setStatus(id, 'succeeded');

    const bundle = await getDealBundle(ev.hubspot_deal_id);
    const p = bundle.deal.properties;
    setStatus(id, 'processing', { deal_name: p.dealname ?? null, currency: p.deal_currency_code ?? null });

    if (p.dealstage !== config.hubspot.closedWonStageId) {
      audit(id, 'system', 'skipped', { dealstage: p.dealstage });
      return setStatus(id, 'skipped', { last_error: `Deal stage is "${p.dealstage}", not closed-won` });
    }
    if (config.hubspot.pipelineId && p.pipeline !== config.hubspot.pipelineId) {
      return setStatus(id, 'skipped', { last_error: `Pipeline "${p.pipeline}" not in scope` });
    }

    const amount = parseAmount(p.amount);
    setStatus(id, 'processing', { amount });
    if (config.approvalThreshold > 0 && amount >= config.approvalThreshold && !ev.approved) {
      audit(id, 'system', 'approval_required', { amount, threshold: config.approvalThreshold });
      return setStatus(id, 'needs_approval');
    }
    if (!config.qbo.itemId) throw new PermanentError('QBO_ITEM_ID is not set (see README section 2)');

    const customerId = await findOrCreateCustomer(id, customerKey(bundle), bundle);
    setStatus(id, 'processing', { qbo_customer_id: customerId });

    const invoice = buildInvoice({ bundle, customerId, amount });
    const { Invoice } = await qbo('POST', '/invoice', { body: invoice, requestId: requestId('inv', ev.idempotency_key) });

    setStatus(id, 'succeeded', { qbo_invoice_id: Invoice.Id, qbo_invoice_total: Invoice.TotalAmt, last_error: null });
    audit(id, 'system', 'invoice_created', { invoiceId: Invoice.Id, docNumber: Invoice.DocNumber, total: Invoice.TotalAmt });
    logger.info({ eventId: id, dealId: ev.hubspot_deal_id, invoiceId: Invoice.Id }, 'synced');
  } catch (err) {
    const retryable = err.retryable !== false && ev.attempts < config.maxAttempts;
    const delay = Math.min(3_600_000, 30_000 * 2 ** (ev.attempts - 1)); // 30s, 1m, 2m, 4m ... capped at 1h
    setStatus(id, retryable ? 'failed' : 'needs_review', { last_error: String(err.message).slice(0, 1000), next_attempt_at: Date.now() + delay });
    audit(id, 'system', retryable ? 'attempt_failed_will_retry' : 'moved_to_needs_review', { error: String(err.message).slice(0, 500), attempt: ev.attempts });
    logger.warn({ eventId: id, err: err.message, retryable }, 'sync attempt failed');
  }
}
