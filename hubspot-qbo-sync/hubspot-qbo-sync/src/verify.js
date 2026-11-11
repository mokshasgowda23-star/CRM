import crypto from 'node:crypto';
import { config } from './config.js';

export const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// HubSpot's v3 instructions say to URL-decode certain characters in the URI before hashing.
// Re-check this list against the current docs when you build this.
const DECODE = { '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$', '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';' };
const decodeUri = (u) => u.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODE[m.toUpperCase()]);

/** `req.body` must be the RAW Buffer (express.raw): hashing re-serialised JSON will never match. */
export function verifyWebhook(req) {
  if (config.webhookAuthMode === 'token') {
    return safeEq(req.get('x-webhook-token') ?? req.query.token ?? '', config.webhookSharedToken);
  }
  const sig = req.get('x-hubspot-signature-v3');
  const ts = req.get('x-hubspot-request-timestamp');
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false; // replay protection: reject > 5 min old
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const source = req.method + decodeUri(config.publicBaseUrl + req.originalUrl) + raw + ts;
  const expected = crypto.createHmac('sha256', config.hubspot.clientSecret).update(source, 'utf8').digest('base64');
  return safeEq(sig, expected);
}
