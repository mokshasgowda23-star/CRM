// Usage: npm run simulate -- <dealId> [--twice] [--bad-sig]
import crypto from 'node:crypto';

const [dealId = '123456789', ...flags] = process.argv.slice(2);
const mode = process.env.WEBHOOK_AUTH_MODE ?? 'v3';
const base = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const path = '/webhooks/hubspot';
const body = JSON.stringify({ object: { objectId: Number(dealId), objectType: 'DEAL' } });

async function send() {
  const ts = Date.now().toString();
  const headers = { 'Content-Type': 'application/json' };
  if (mode === 'token') {
    headers['x-webhook-token'] = flags.includes('--bad-sig') ? 'wrong' : process.env.WEBHOOK_SHARED_TOKEN;
  } else {
    // Sign exactly like HubSpot: method + public URI + raw body + timestamp, HMAC-SHA256, base64.
    const sig = crypto.createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET).update('POST' + base + path + body + ts, 'utf8').digest('base64');
    headers['x-hubspot-request-timestamp'] = ts;
    headers['x-hubspot-signature-v3'] = flags.includes('--bad-sig') ? 'AAAA' : sig;
  }
  const res = await fetch(`http://localhost:${process.env.PORT ?? 3000}${path}`, { method: 'POST', headers, body });
  console.log(res.status, await res.text());
}
await send();
if (flags.includes('--twice')) await send(); // proves duplicate-delivery handling
