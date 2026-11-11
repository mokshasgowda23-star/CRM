import fs from 'node:fs';
import { config } from './config.js';
import { HttpError, PermanentError } from './errors.js';

const BASE = 'https://api.hubapi.com';

async function hs(path) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${config.hubspot.token}` } });
  } catch (e) {
    throw new HttpError('HubSpot', 503, `network error: ${e.message}`); // retryable
  }
  if (!res.ok) throw new HttpError('HubSpot', res.status, await res.text());
  return res.json();
}

/** Re-fetch everything from HubSpot instead of trusting the webhook body. */
export async function getDealBundle(dealId) {
  if (config.mockHubspot) {
    const m = JSON.parse(fs.readFileSync(new URL('../samples/mock-deal.json', import.meta.url)));
    m.deal.id = String(dealId);
    return m;
  }
  const deal = await hs(
    `/crm/v3/objects/deals/${dealId}?properties=dealname,amount,dealstage,pipeline,closedate,deal_currency_code&associations=contacts,companies`,
  );
  // MVP rule: first associated record. Your decision: prefer the "Primary" company via the v4 associations API.
  const contactId = deal.associations?.contacts?.results?.[0]?.id;
  const companyId = deal.associations?.companies?.results?.[0]?.id;
  const [contact, company] = await Promise.all([
    contactId ? hs(`/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone`) : null,
    companyId ? hs(`/crm/v3/objects/companies/${companyId}?properties=name,domain,phone`) : null,
  ]);
  if (!contact && !company) throw new PermanentError('Deal has no associated contact or company');
  return { deal, contact, company };
}
