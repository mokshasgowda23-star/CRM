import pino from 'pino';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k} (see .env.example)`);
  return v;
};
const opt = (k, d = '') => process.env[k] || d;
const bool = (k) => opt(k, 'false').toLowerCase() === 'true';

const qboEnv = opt('QBO_ENV', 'sandbox');
if (!['sandbox', 'production'].includes(qboEnv)) throw new Error('QBO_ENV must be sandbox or production');

const webhookAuthMode = opt('WEBHOOK_AUTH_MODE', 'v3');
const mockHubspot = bool('MOCK_HUBSPOT');

export const config = {
  port: Number(opt('PORT', '3000')),
  publicBaseUrl: opt('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  dbPath: opt('DB_PATH', './data/sync.db'),
  adminToken: need('ADMIN_TOKEN'),
  tokenEncKey: need('TOKEN_ENC_KEY'),
  approvalThreshold: Number(opt('APPROVAL_THRESHOLD', '0')),
  maxAttempts: Number(opt('MAX_ATTEMPTS', '6')),
  netDays: Number(opt('DEFAULT_NET_DAYS', '30')),
  mockHubspot,
  webhookAuthMode,
  webhookSharedToken: webhookAuthMode === 'token' ? need('WEBHOOK_SHARED_TOKEN') : '',
  hubspot: {
    token: mockHubspot ? '' : need('HUBSPOT_ACCESS_TOKEN'),
    clientSecret: webhookAuthMode === 'v3' ? need('HUBSPOT_CLIENT_SECRET') : '',
    closedWonStageId: opt('HUBSPOT_CLOSED_WON_STAGE_ID', 'closedwon'),
    pipelineId: opt('HUBSPOT_PIPELINE_ID'),
  },
  qbo: {
    env: qboEnv,
    apiBase: qboEnv === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com',
    clientId: need('QBO_CLIENT_ID'),
    clientSecret: need('QBO_CLIENT_SECRET'),
    redirectUri: need('QBO_REDIRECT_URI'),
    minorVersion: opt('QBO_MINOR_VERSION', '75'),
    itemId: opt('QBO_ITEM_ID'),
    termId: opt('QBO_TERM_ID'),
    taxCodeId: opt('QBO_TAX_CODE_ID'),
    multiCurrency: bool('QBO_MULTICURRENCY'),
  },
};

if (Buffer.from(config.tokenEncKey, 'hex').length !== 32) throw new Error('TOKEN_ENC_KEY must be 64 hex chars (32 bytes)');
if (qboEnv === 'production' && !config.publicBaseUrl.startsWith('https://')) throw new Error('Production requires an https PUBLIC_BASE_URL');

export const logger = pino({
  level: opt('LOG_LEVEL', 'info'),
  redact: ['*.accessToken', '*.refreshToken', 'req.headers.authorization'],
});
