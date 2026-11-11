# HubSpot "Closed Won" → QuickBooks Online sync

Node.js middleware: HubSpot deal webhook → verify → re-fetch deal + contact + company → find/create QBO customer → create QBO invoice.
Includes idempotency, a retry queue, an audit log, approval for large deals, and an admin dashboard.

> **Status of this guide:** API details were checked against HubSpot and Intuit documentation on 7 Nov 2026
> (see the Verification log at the end for what was and was not confirmed). Both vendors change things often:
> re-read the official docs before relying on any detail for production.

## 1. Architecture

```
HubSpot (deal -> Closed Won)
   |  POST (signed)                      +--------------------------------+
   v                                     | SQLite: sync_events (UNIQUE     |
[ /webhooks/hubspot ] -- verify -------> | idempotency key), audit_log,    |
   |  200 OK immediately                 | customer_map, oauth_tokens      |
   v                                     | (AES-256-GCM encrypted)         |
[ worker loop ] -> HubSpot API (deal + contact + company, re-fetched)
   |             -> QBO: query/create Customer -> create Invoice (requestid)
   |             -> retry w/ backoff | needs_approval | needs_review
   v
[ /admin dashboard ]  status, retry, approve, per-event history
```

Key decisions in plain language:

- **Ack fast, work later.** The webhook handler only verifies and records. A worker does the slow API calls. HubSpot retries slow or failed deliveries, so a quick 200 prevents retry storms.
- **Never trust the webhook body.** It only tells us *which deal*. We re-fetch from HubSpot and re-check the stage.
- **Two layers of duplicate protection.** (1) A UNIQUE idempotency key per deal + transition in our DB. (2) QBO's `requestid` on every write, so a retry after a timeout should not create a second invoice.
- **SQLite for the MVP.** Zero setup. Move to Postgres plus a real queue if you run more than one instance.

## 2. Decisions YOU must make (nothing here is guessed)

| Decision | Why it matters | Where |
|---|---|---|
| **QBO Product/Service (Item) Id** for invoice lines | Every line needs an `ItemRef`; the Item's income account decides where revenue is booked. Create e.g. "HubSpot Deal Revenue" (type Service) in QBO, then find its Id (`select Id, Name from Item`) | `QBO_ITEM_ID` |
| **Tax handling** | US companies with automated sales tax: usually leave `QBO_TAX_CODE_ID` blank and test. Non-US companies: lines typically need an explicit tax code. Which one (or none) is an accounting decision | `QBO_TAX_CODE_ID` |
| **Currency** | If QBO Multicurrency is off, the invoice uses the home currency and `CurrencyRef` should not be sent. If on, deals must carry a currency both systems agree on | `QBO_MULTICURRENCY` |
| **Payment terms** | A QBO Term Id (`select Id, Name from Term`) or close date + N days | `QBO_TERM_ID`, `DEFAULT_NET_DAYS` |
| **Does HubSpot `amount` include tax?** | Decides whether QBO adds tax on top | your finance team |
| **One line or line items?** | MVP sends one line (deal name + amount). Real quotes need HubSpot line items mapped to QBO Items | `src/mapping.js` |
| **Which company/contact is "the customer"** | MVP: first associated company, else first contact. Better: the Primary-labelled company | `src/hubspot.js` |
| **Customer = company or person?** | B2B is usually the company. QBO `DisplayName` must be unique across customers, vendors and employees | `src/mapping.js` |
| **Closed-won stage id** | It is the internal id, not the label; custom pipelines differ | `HUBSPOT_CLOSED_WON_STAGE_ID` |
| **Auto-email the invoice?** | Off by default (safe for demos). Enabling it is a separate QBO call you would add | n/a |
| **Re-opened deals / amount changes** | MVP syncs each deal once. Decide: credit memo, update, or alert | idempotency key |
| **Approval threshold** | Deals at or above this wait for a human | `APPROVAL_THRESHOLD` |

## 3. Setup

```bash
cd hubspot-qbo-sync
npm install                     # express, better-sqlite3, pino (Node >= 20.6)
cp .env.example .env            # fill it in; .env is git-ignored
openssl rand -hex 32            # -> TOKEN_ENC_KEY
openssl rand -hex 24            # -> ADMIN_TOKEN
npm run dev
```

**Credentials policy:** secrets live only in `.env` or your host's secret manager. `.gitignore` excludes `.env` and the SQLite files.
If a secret was ever committed, rotate it; deleting the file is not enough.

**Sandbox vs production** are separated three ways: (1) `QBO_ENV` selects the API base
(`sandbox-quickbooks.api.intuit.com` vs `quickbooks.api.intuit.com`); (2) Intuit issues different keys for each (Development vs Production);
(3) tokens are stored per environment and the dashboard shows a yellow SANDBOX or red PRODUCTION banner. The server refuses production without HTTPS.
Use a **HubSpot developer test account** for demos, never your real CRM.

## 4. HubSpot setup and request verification

You need a public HTTPS URL: `ngrok http 3000` or Cloudflare Tunnel for local work. Put it in `PUBLIC_BASE_URL`.

**Trigger option A: app webhook subscription** (`deal.propertyChange` on `dealstage`). Works in a free developer account.
HubSpot's app platform has been changing, so follow its current webhooks / developer-platform docs to register the subscription and the
target URL `https://<host>/webhooks/hubspot`. Requests are signed with the app's **client secret**, so use `WEBHOOK_AUTH_MODE=v3`.
A subscription fires for *every* stage change; the server filters for `propertyValue === HUBSPOT_CLOSED_WON_STAGE_ID`.

**Trigger option B: workflow "Send a webhook" action**, enrolment criteria "Deal stage is Closed won". Include the deal **Record ID**
in the body. Check your HubSpot plan: this action has historically required a paid Operations Hub tier (verify).
Check in the action's settings how it authenticates. If it cannot sign with a client secret, use `WEBHOOK_AUTH_MODE=token` and put a
secret in a header (`x-webhook-token`) or in the URL (`?token=...`, which will appear in access logs, so rotate it).

**Verification (v3)**, implemented in `src/verify.js` per HubSpot's docs: HMAC-SHA256 keyed with the client secret over
`method + full public URI + raw body + timestamp`, base64-encoded, compared in constant time with `X-HubSpot-Signature-v3`;
the `X-HubSpot-Request-Timestamp` is rejected when older than 5 minutes. Pitfalls: hash the **raw bytes** (that is why the route uses `express.raw`),
and the URI must match what HubSpot called (your public host, not `localhost`).

**First real delivery:** run with `LOG_LEVEL=debug`; the raw body is logged in sandbox mode. Compare it with `extractDealIds()` in `src/server.js`
and tighten it. The accepted shapes were written from documentation, not from a live capture.

For reading deals, create a private app / service key with read access to deals, contacts and companies and use it as `HUBSPOT_ACCESS_TOKEN`
(check current scope names in the HubSpot UI).

## 5. QuickBooks OAuth 2.0

1. Intuit Developer account → create an app → **Accounting** scope. Use the **Development** keys with the auto-created sandbox company.
2. Add `https://<host>/auth/qbo/callback` as a redirect URI in the app's Development settings; it must match `QBO_REDIRECT_URI` exactly.
3. Start the server and open `https://<host>/auth/qbo/connect?token=<ADMIN_TOKEN>`; sign in, choose the sandbox company, approve.
4. The callback receives `code` and `realmId` (the company id), exchanges the code, and stores tokens **encrypted** (AES-256-GCM) in SQLite.

Token facts (Intuit authorization FAQ): access tokens last 3,600 seconds; refresh tokens last 100 days on a rolling basis, and
**a new refresh token is issued on refresh, making the previous one stale**; there is also a maximum lifetime (5 years per the FAQ).
Intuit's SDK release notes show the refresh policy has been changing, so rely on the response values, not constants. What `src/qbo.js` does:

- refreshes proactively 60 s before expiry, and once more on a 401 before retrying;
- **persists the new refresh token immediately**;
- serialises refreshes in-process to avoid two workers racing and invalidating each other;
- turns rejected refreshes into a clear "reconnect QuickBooks" `needs_review` state instead of an infinite retry loop.

If you ever run 2+ instances, move that lock into the database. If traffic is sparse, add a daily health call so the refresh token stays active.
Intuit has also introduced app-partner pricing/usage tiers for the API: irrelevant for a sandbox demo, but check current terms before production.

## 6. Field mapping and customer matching

| HubSpot | QuickBooks | Notes |
|---|---|---|
| company.name (else contact full name, else email) | Customer.DisplayName | `:` and control characters removed; unique in QBO |
| company.name | Customer.CompanyName | truncated to 50 |
| contact.firstname / lastname | GivenName / FamilyName | truncated to 25 |
| contact.email | PrimaryEmailAddr.Address and Invoice.BillEmail | |
| company.phone or contact.phone | PrimaryPhone.FreeFormNumber | |
| deal.dealname + id | Line.Description | traceability back to HubSpot |
| deal.amount | Line.Amount, UnitPrice, Qty 1 | validated > 0, rounded to cents |
| deal.closedate | TxnDate | UTC date; consider your company time zone |
| (config) | ItemRef, SalesTermRef or DueDate, TaxCodeRef, CurrencyRef | see section 2 |
| deal.id | Invoice.PrivateNote | |

Matching order: (1) local `customer_map` (HubSpot company/contact id → QBO id); (2) QBO query on `DisplayName`; (3) create.
Matching by email is attractive but not used because I did not confirm that `PrimaryEmailAddr` is a supported query filter. Verify before adding it.
Known gaps: billing-address mapping, inactive same-name customers (creation fails → review), and fuzzy matching ("Acme Inc" vs "Acme, Inc.").
Field length limits above are from memory of the Customer entity reference: verify them.

## 7. Invoice creation

The minimum valid invoice is a `CustomerRef` plus at least one `Line` with `DetailType: SalesItemLineDetail` and an `ItemRef`.
POST `/v3/company/{realmId}/invoice?minorversion=75&requestid=...` (`QBO_MINOR_VERSION` is configurable; pick a current one from Intuit's docs).
Treat the response `TotalAmt` as the truth: if QBO adds tax it can differ from the HubSpot amount, which is exactly what a reconciliation alert would flag.

## 8. Duplicates, idempotency, errors, retries, audit

- **Duplicate deliveries:** `INSERT OR IGNORE` on `deal:<id>:closed-won`. A second delivery is logged as `duplicate_ignored` and still gets a 200.
- **Concurrency:** rows are claimed atomically (`UPDATE ... WHERE status IN ('pending','failed')`).
- **Crash between "QBO created the invoice" and "we saved it":** the retry reuses the same `requestid`, so QBO should not create a second invoice. Confirm the dedupe window in Intuit's docs; for extra safety add a `DocNumber` lookup.
- **Error classes:** network, 429, 5xx → retry with exponential backoff (30 s, 1 m, 2 m… capped at 1 h, up to `MAX_ATTEMPTS`). 4xx, validation, missing data, auth → `needs_review`; a human fixes it, then clicks Retry.
- **Statuses:** `pending → processing → succeeded | failed (will retry) | needs_review | needs_approval | skipped`.
- **Audit:** append-only `audit_log` for every receive, attempt, customer match/create, invoice, approval and manual action. QBO error messages include the `intuit_tid` header, which Intuit support asks for.
- **Logging:** pino JSON with tokens redacted. Don't log customer PII in production.

## 9. Local testing

```bash
# A) No accounts needed: fake HubSpot data; tests signature, idempotency and retry logic.
#    In .env: MOCK_HUBSPOT=true, HUBSPOT_CLIENT_SECRET=anything, WEBHOOK_AUTH_MODE=v3
npm run dev
npm run simulate -- 123456789 --twice     # second delivery must report duplicate:true
npm run simulate -- 123456789 --bad-sig   # must return 401
# Dashboard: http://localhost:3000/admin?token=<ADMIN_TOKEN>

# B) QuickBooks sandbox: connect via /auth/qbo/connect, set QBO_ITEM_ID, then click Retry in the dashboard.
# C) Real HubSpot: MOCK_HUBSPOT=false, point the trigger at your tunnel, move a test deal to Closed won.
```

Failure drills to run before the demo: wrong `QBO_ITEM_ID` (→ `needs_review`), disconnect the app in QBO (→ reconnect message),
stop the tunnel mid-run (HubSpot retries; we dedupe), empty `amount` (→ `needs_review`), deal over the threshold (→ `needs_approval`).

## 10. Deployment

Any host with a persistent disk and HTTPS (Render, Railway, Fly.io, or a VPS behind Caddy/Nginx). Set env vars in the host's secret store,
mount a volume at `data/`, run `npm start`, add the production redirect URI in Intuit's **Production** settings, and register the final webhook URL in HubSpot.

Sandbox → production checklist: separate Production keys; `QBO_ENV=production`; reconnect (sandbox tokens do not carry over);
real Item/Term/Tax ids (they differ from sandbox); confirm HubSpot stage ids; test with one low-value real deal; back up the SQLite file;
confirm Intuit's production-app requirements.

## 11. Verification log

**Confirmed in current docs on 7 Nov 2026:** HubSpot v3 signature recipe and the 5-minute timestamp rule; QBO invoice minimum fields and `minorversion`;
sandbox/production base URLs; access token 3,600 s; refresh-token rolling expiry, rotation and stale-token behaviour (Intuit FAQ).

**Not independently confirmed (verify before relying):** the workflow webhook action's payload shape and whether it is signed; its plan requirements;
the URI-decoding list for v3; QBO `requestid` max length and dedupe window (seen only in third-party docs); customer field length limits;
whether `PrimaryEmailAddr` is queryable; Intuit's current API pricing tiers and production-app requirements; `CurrencyRef` rules beyond
"only with Multicurrency" (third-party source).

## 12. Demo script (about 3 minutes)

1. **Problem (20 s):** "A rep closes a deal; finance re-types it into QuickBooks. It's slow and error-prone."
2. **Show both systems (20 s):** HubSpot test deal in "Contract sent"; QuickBooks sandbox with no customer or invoice yet; dashboard open with the SANDBOX banner.
3. **Trigger (30 s):** drag the deal to Closed won. A dashboard row appears and turns `succeeded`.
4. **Result (30 s):** QuickBooks now has the customer and an invoice with the right amount, terms and a reference to the deal id.
5. **Safety (40 s):** replay the same webhook: still one invoice (`duplicate_ignored` in the history). Send a tampered request: 401.
6. **Resilience (30 s):** break the Item id → `needs_review` with a plain-English error → fix → Retry → `succeeded`.
7. **Control (20 s):** a deal above the threshold waits for Approve. Close on the audit history.

## 13. Feature ideas

| Feature | Value | Effort |
|---|---|---|
| Sync-status dashboard | Judges *see* it work; ops trust it | **Included** |
| Retry queue + backoff | Survives outages | **Included** |
| Audit history | Finance and compliance story | **Included** |
| Approval for unusual deals | Human control over big or odd invoices | **Included** (extend: new customer, discount, missing PO) |
| Dry-run / preview mode | Shows the exact QBO payload before sending | Small |
| Slack/Teams notifications (success, needs review) | Visible outcomes, faster fixes | Small |
| Configurable field mapping (JSON/YAML + validation) | Reusable across companies; sells "platform" | Medium |
| Reconciliation alerts (scheduled job compares HubSpot amount vs QBO `TotalAmt`, flags drift or missing invoices) | Catches silent errors and tax differences | Medium |
| Payment status back to HubSpot (QBO webhooks or CDC → "Paid" deal property) | Closes the loop; reps see cash collected | Medium to large |
| HubSpot line items → invoice lines, with SKU → QBO Item mapping | Realistic invoices | Medium |
| Smart customer dedupe (fuzzy name/domain match; optional LLM-assisted suggestion with human confirmation) | Fewer duplicate customers, the #1 real-world pain | Medium |
| Credit memo or alert when a synced deal is re-opened or its amount changes | Handles the hardest edge case | Medium |
| Multi-tenant (many HubSpot/QBO pairs) | A product, not a script | Large |
