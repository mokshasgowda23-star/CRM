import { db } from './db.js';
import { logger } from './config.js';
import { processEvent } from './sync.js';

let running = false;

export async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = db.prepare(`SELECT id FROM sync_events WHERE status IN ('pending','failed') AND next_attempt_at <= ? ORDER BY id LIMIT 10`).all(Date.now());
    for (const r of rows) await processEvent(r.id); // sequential on purpose: gentle on rate limits
  } catch (e) {
    logger.error({ err: e }, 'worker tick crashed');
  } finally {
    running = false;
  }
}

export const kick = () => setImmediate(tick);

export function startWorker() {
  // Single-instance assumption: anything left "processing" by a crash gets retried (safe: QBO requestid dedupes).
  db.prepare(`UPDATE sync_events SET status='failed', next_attempt_at=0 WHERE status='processing'`).run();
  setInterval(tick, 5000).unref();
  kick();
}
