// Загрузка отзывов с карт по всем клиентам: один браузер на прогон, прогоны не пересекаются.
import { db, insertReview } from '../db.js';
import { openBrowser, scrapeYandex, scrapeGoogle } from './maps.js';

let running = null;
export const syncState = { running: false, last_run: null, last_report: [] };

const knownIds = (clientId, source) =>
  new Set(db.prepare('SELECT external_id FROM reviews WHERE client_id = ? AND source = ?').all(clientId, source).map((r) => r.external_id));

async function run(clientId, max) {
  const clients = clientId
    ? db.prepare('SELECT * FROM clients WHERE id = ?').all(clientId)
    : db.prepare("SELECT * FROM clients WHERE yandex_org_url != '' OR google_maps_url != ''").all();
  const report = [];
  if (!clients.some((c) => c.yandex_org_url || c.google_maps_url)) return report;
  const ctx = await openBrowser();
  try {
    for (const c of clients) {
      for (const [source, url, scrape] of [['yandex', c.yandex_org_url, scrapeYandex], ['google', c.google_maps_url, scrapeGoogle]]) {
        if (!url) continue;
        const item = { client: c.name, source };
        try {
          const { title, reviews, limited } = await scrape(ctx, url, { known: knownIds(c.id, source), ...(max ? { max } : {}) });
          let added = 0;
          for (const r of reviews) if (insertReview({ ...r, client_id: c.id })) added++;
          Object.assign(item, { place: title, fetched: reviews.length, added });
          if (limited) item.warning = 'Google без входа в аккаунт показывает только несколько отзывов. Выполните npm run google-login';
        } catch (e) {
          item.error = e.message.split('\n')[0];
        }
        report.push(item);
        console.log(`Парсер: ${c.name} / ${source}: ${item.error ? `ошибка — ${item.error}` : `получено ${item.fetched}, новых ${item.added}`}`);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return report;
}

export function syncMaps(clientId, max) {
  if (running) return running;
  syncState.running = true;
  running = run(clientId, max)
    .then((report) => { syncState.last_report = report; return report; })
    .finally(() => { running = null; syncState.running = false; syncState.last_run = new Date().toISOString(); });
  return running;
}
