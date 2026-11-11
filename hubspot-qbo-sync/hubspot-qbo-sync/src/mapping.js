import { config } from './config.js';
import { PermanentError } from './errors.js';

// Length limits below are from memory of the Customer entity docs: verify them for your minor version.
const clean = (s) => String(s ?? '').replace(/[:\t\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseAmount(raw) {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new PermanentError(`Deal amount "${raw}" is missing or not positive`);
  return Math.round(n * 100) / 100;
}

export function customerKey({ company, contact }) {
  if (company) return `company:${company.id}`;
  if (contact) return `contact:${contact.id}`;
  throw new PermanentError('Deal has no company or contact');
}

export function buildCustomer({ company, contact }) {
  const cp = company?.properties ?? {};
  const c = contact?.properties ?? {};
  const person = clean([c.firstname, c.lastname].filter(Boolean).join(' '));
  const displayName = clean(cp.name) || person || clean(c.email);
  if (!displayName) throw new PermanentError('Cannot derive a customer name (no company name, contact name or email)');
  const phone = cp.phone || c.phone;
  return {
    DisplayName: displayName.slice(0, 500),
    ...(cp.name && { CompanyName: clean(cp.name).slice(0, 50) }),
    ...(c.firstname && { GivenName: clean(c.firstname).slice(0, 25) }),
    ...(c.lastname && { FamilyName: clean(c.lastname).slice(0, 25) }),
    ...(c.email && { PrimaryEmailAddr: { Address: c.email } }),
    ...(phone && { PrimaryPhone: { FreeFormNumber: phone } }),
  };
}

export function buildInvoice({ bundle, customerId, amount }) {
  const { deal, contact } = bundle;
  const p = deal.properties;
  const txnDate = (p.closedate ? new Date(p.closedate) : new Date()).toISOString().slice(0, 10);
  const due = new Date(txnDate);
  due.setUTCDate(due.getUTCDate() + config.netDays);

  return {
    CustomerRef: { value: customerId },
    TxnDate: txnDate,
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: `${p.dealname ?? 'HubSpot deal'} (HubSpot deal ${deal.id})`.slice(0, 4000),
        SalesItemLineDetail: {
          ItemRef: { value: config.qbo.itemId },
          Qty: 1,
          UnitPrice: amount,
          ...(config.qbo.taxCodeId && { TaxCodeRef: { value: config.qbo.taxCodeId } }),
        },
      },
    ],
    ...(config.qbo.termId ? { SalesTermRef: { value: config.qbo.termId } } : { DueDate: due.toISOString().slice(0, 10) }),
    ...(contact?.properties?.email && { BillEmail: { Address: contact.properties.email } }),
    // CurrencyRef is only meaningful when the QBO company has Multicurrency enabled.
    ...(config.qbo.multiCurrency && p.deal_currency_code && { CurrencyRef: { value: p.deal_currency_code } }),
    PrivateNote: `Created by hubspot-qbo-sync from HubSpot deal ${deal.id}`,
  };
}
