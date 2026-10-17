import express from 'express';
import { fileURLToPath } from 'node:url';
import { db, insertReview, withOverdue, SLA_HOURS } from './db.js';
import { analyzeReview, aiEnabled, monthlySummary } from './ai.js';
import { reviewsFromCsv } from './sources/csv.js';
import { fetchGoogleReviews, googleConfigured } from './sources/google.js';
import { syncMaps, syncState } from './sources/sync.js';
import { browserPath } from './sources/maps.js';
import { problemsReport } from './problems.js';
import { extractMeeting } from './meetings-ai.js';
import { startTelegram, sendDailyReport, dailyReport, telegramInfo } from './telegram.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const getClient = (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

// ---------- Очередь ИИ-обработки ----------
let processing = false;
export async function processPending() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const r = db.prepare("SELECT * FROM reviews WHERE status = 'new' AND owner_reply = '' ORDER BY created_at DESC LIMIT 1").get();
      if (!r) break;
      try {
        const out = await analyzeReview(r, getClient(r.client_id));
        db.prepare(`UPDATE reviews SET sentiment=?, topic=?, urgency=?, draft_reply=?, ai_engine=?, status='draft_ready' WHERE id=? AND status='new'`)
          .run(out.sentiment, out.topic.slice(0, 100), out.urgency, out.draft_reply, out.ai_engine, r.id);
      } catch (e) {
        // Отзыв остаётся «в очереди», следующая попытка при следующем запуске очереди.
        console.error(`Отзыв ${r.id}: ${e.message}`);
        break;
      }
    }
  } finally {
    processing = false;
  }
}
setInterval(processPending, 60_000).unref();

// ---------- Статус ----------
app.get('/api/status', (req, res) => {
  res.json({ ai: aiEnabled(), google: googleConfigured(), telegram: telegramInfo(), sla_hours: SLA_HOURS, processing, parser: { ...syncState, browser: Boolean(browserPath()), interval_hours: PARSER_INTERVAL_H } });
});

// ---------- Клиенты и брифы ----------
const BRIEF = ['name', 'services', 'tone', 'contacts', 'stop_words', 'google_location', 'yandex_org_url', 'google_maps_url'];
function briefFromBody(b) {
  const o = {};
  for (const k of BRIEF) {
    const v = String(b[k] ?? '').trim();
    if (v.length > 2000) throw bad(`Поле «${k}» длиннее 2000 символов`);
    o[k] = v;
  }
  if (!o.name) throw bad('Укажите название клиента');
  return o;
}
app.get('/api/clients', (req, res) => res.json(db.prepare('SELECT * FROM clients ORDER BY name').all()));
app.post('/api/clients', wrap((req, res) => {
  const o = briefFromBody(req.body);
  const r = db.prepare(`INSERT INTO clients (${BRIEF.join(',')}) VALUES (${BRIEF.map(() => '?').join(',')})`).run(...BRIEF.map((k) => o[k]));
  res.json(getClient(r.lastInsertRowid));
}));
app.put('/api/clients/:id', wrap((req, res) => {
  const o = briefFromBody(req.body);
  db.prepare(`UPDATE clients SET ${BRIEF.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...BRIEF.map((k) => o[k]), req.params.id);
  res.json(getClient(req.params.id));
}));
app.delete('/api/clients/:id', wrap((req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Отзывы ----------
function reviewFilter(q) {
  const where = [], args = [];
  if (q.client_id) { where.push('r.client_id = ?'); args.push(q.client_id); }
  if (q.source) { where.push('r.source = ?'); args.push(q.source); }
  if (q.from) { where.push('r.created_at >= ?'); args.push(q.from); }
  if (q.to) { where.push('r.created_at < ?'); args.push(q.to); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

app.get('/api/reviews', (req, res) => {
  const f = reviewFilter(req.query);
  let rows = db.prepare(`SELECT r.*, c.name AS client_name FROM reviews r JOIN clients c ON c.id = r.client_id ${f.sql} ORDER BY r.created_at DESC`)
    .all(...f.args).map(withOverdue);
  if (req.query.status) rows = rows.filter((r) => r.display_status === req.query.status);
  res.json(rows);
});

const getReview = (id) => withOverdue(db.prepare('SELECT r.*, c.name AS client_name FROM reviews r JOIN clients c ON c.id=r.client_id WHERE r.id=?').get(id));

app.patch('/api/reviews/:id', wrap((req, res) => {
  const draft = String(req.body.draft_reply ?? '').trim();
  if (!draft) throw bad('Пустой ответ');
  db.prepare("UPDATE reviews SET draft_reply=?, status='draft_ready', approved_at=NULL WHERE id=?").run(draft, req.params.id);
  res.json(getReview(req.params.id));
}));

app.post('/api/reviews/:id/approve', wrap((req, res) => {
  const r = getReview(req.params.id);
  if (!r?.draft_reply) throw bad('Нет черновика для одобрения');
  db.prepare("UPDATE reviews SET status='approved', approved_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json(getReview(req.params.id));
}));

app.post('/api/reviews/:id/regenerate', wrap(async (req, res) => {
  const r = getReview(req.params.id);
  if (!r) throw bad('Отзыв не найден');
  const out = await analyzeReview(r, getClient(r.client_id), String(req.body.hint || '').slice(0, 500));
  db.prepare("UPDATE reviews SET sentiment=?, topic=?, urgency=?, draft_reply=?, ai_engine=?, status='draft_ready', approved_at=NULL WHERE id=?")
    .run(out.sentiment, out.topic.slice(0, 100), out.urgency, out.draft_reply, out.ai_engine, r.id);
  res.json(getReview(r.id));
}));

// ---------- Источники ----------
app.post('/api/import/csv', wrap((req, res) => {
  const { client_id, source = 'yandex', csv } = req.body;
  if (!getClient(client_id)) throw bad('Выберите клиента');
  if (!['google', 'yandex'].includes(source)) throw bad('Источник: google или yandex');
  const { reviews, errors } = reviewsFromCsv(String(csv || ''), source);
  let added = 0;
  for (const r of reviews) if (insertReview({ ...r, client_id })) added++;
  processPending();
  res.json({ added, skipped: reviews.length - added, errors });
}));

app.post('/api/sync/google', wrap(async (req, res) => {
  if (!googleConfigured()) throw bad('Google не настроен: заполните GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN в .env');
  const clients = req.body.client_id ? [getClient(req.body.client_id)] : db.prepare("SELECT * FROM clients WHERE google_location != ''").all();
  const report = [];
  for (const c of clients) {
    try {
      const list = await fetchGoogleReviews(c.google_location);
      let added = 0;
      for (const r of list) if (insertReview({ ...r, client_id: c.id })) added++;
      report.push({ client: c.name, fetched: list.length, added });
    } catch (e) {
      report.push({ client: c.name, error: e.message });
    }
  }
  processPending();
  res.json(report);
}));

// Парсер Яндекс и Google Карт: вручную из «Источников» и по расписанию.
app.post('/api/sync/maps', wrap(async (req, res) => {
  if (syncState.running) throw bad('Загрузка уже идёт, дождитесь окончания');
  const max = Math.min(Number(req.body.max) || 0, 2000) || undefined;
  const report = await syncMaps(req.body.client_id || null, max);
  processPending();
  res.json(report);
}));

const PARSER_INTERVAL_H = Number(process.env.PARSER_INTERVAL_HOURS ?? 6);
if (PARSER_INTERVAL_H > 0) {
  setInterval(() => syncMaps().then(processPending).catch((e) => console.error(`Парсер: ${e.message}`)), PARSER_INTERVAL_H * 36e5).unref();
}

// ---------- Telegram ----------
app.get('/api/telegram/preview', (req, res) => res.json({ text: dailyReport() }));
app.post('/api/telegram/send', wrap(async (req, res) => {
  try {
    res.json(await sendDailyReport());
  } catch (e) {
    throw bad(e.message);
  }
}));

// ---------- Встречи (календарь) ----------
app.get('/api/meetings', (req, res) => {
  const where = [], args = [];
  if (req.query.from) { where.push('m.starts_at >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('m.starts_at < ?'); args.push(req.query.to); }
  if (req.query.client_id) { where.push('m.client_id = ?'); args.push(req.query.client_id); }
  res.json(db.prepare(`SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON c.id=m.client_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.starts_at`).all(...args));
});
app.post('/api/meetings', wrap((req, res) => {
  const { title, starts_at, duration_min = 60, notes = '', client_id = null } = req.body;
  if (!String(title || '').trim()) throw bad('Укажите тему встречи');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts_at || '')) throw bad('Укажите дату и время встречи');
  const r = db.prepare('INSERT INTO meetings (client_id, title, starts_at, duration_min, notes) VALUES (?,?,?,?,?)')
    .run(client_id || null, String(title).trim().slice(0, 200), starts_at, Number(duration_min) || 60, String(notes).slice(0, 2000));
  res.json({ id: Number(r.lastInsertRowid) });
}));
// Разбор встречи из свободного текста (тот же, что в Telegram-боте)
app.post('/api/meetings/parse', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) throw bad('Напишите, какую встречу добавить');
  res.json(await extractMeeting(text, { clients: db.prepare('SELECT id, name FROM clients').all(), mode: 'direct' }));
}));
app.delete('/api/meetings/:id', wrap((req, res) => {
  db.prepare('DELETE FROM meetings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Статистика и сводка ----------
function stats(q) {
  const f = reviewFilter(q);
  const rows = db.prepare(`SELECT r.* FROM reviews r ${f.sql}`).all(...f.args).map(withOverdue);
  const count = (fn) => rows.filter(fn).length;
  const rated = rows.filter((r) => r.rating != null);
  const topics = {};
  for (const r of rows) if (r.topic) topics[r.topic] = (topics[r.topic] || 0) + 1;
  const bySource = (s) => {
    const l = rows.filter((r) => r.source === s), rt = l.filter((r) => r.rating != null);
    return { total: l.length, avg_rating: rt.length ? +(rt.reduce((a, r) => a + r.rating, 0) / rt.length).toFixed(2) : null };
  };
  return {
    total: rows.length,
    avg_rating: rated.length ? +(rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(2) : null,
    sentiment: { positive: count((r) => r.sentiment === 'positive'), neutral: count((r) => r.sentiment === 'neutral'), negative: count((r) => r.sentiment === 'negative') },
    status: { new: count((r) => r.display_status === 'new'), draft_ready: count((r) => r.display_status === 'draft_ready'), approved: count((r) => r.display_status === 'approved'), answered: count((r) => r.display_status === 'answered'), overdue: count((r) => r.overdue) },
    sources: { google: bySource('google'), yandex: bySource('yandex') },
    ratings: [1, 2, 3, 4, 5].map((n) => count((r) => r.rating === n)),
    topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 8),
    rows,
  };
}
// Плохие отзывы, разложенные по видам проблем
app.get('/api/problems', (req, res) => {
  const f = reviewFilter(req.query);
  const rows = db.prepare(`SELECT r.*, c.name AS client_name FROM reviews r JOIN clients c ON c.id = r.client_id ${f.sql}`).all(...f.args).map(withOverdue);
  res.json(problemsReport(rows));
});

app.get('/api/stats', (req, res) => {
  const { rows, ...s } = stats(req.query);
  res.json(s);
});

app.post('/api/summary', wrap(async (req, res) => {
  const c = getClient(req.body.client_id);
  if (!c) throw bad('Выберите клиента');
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString(), to = new Date(Date.UTC(y, m, 1)).toISOString();
  const { rows, ...s } = stats({ client_id: c.id, from, to });
  const samples = rows.filter((r) => r.text).sort((a, b) => (a.rating ?? 3) - (b.rating ?? 3)).slice(0, 30);
  let text = s.total ? await monthlySummary(c, s, samples) : null;
  if (!text) {
    text = s.total
      ? `За ${month} получено ${s.total} отзывов, средняя оценка ${s.avg_rating ?? '—'}. Позитивных ${s.sentiment.positive}, нейтральных ${s.sentiment.neutral}, негативных ${s.sentiment.negative}. Частые темы: ${s.topics.map(([t, n]) => `${t} (${n})`).join(', ') || '—'}. Просрочено по SLA: ${s.status.overdue}.`
      : `За ${month} отзывов нет.`;
  }
  res.json({ client: c.name, month, stats: s, text });
}));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`RevAI: http://localhost:${PORT}  (ИИ: ${aiEnabled() ? 'Claude API' : 'эвристика, нет ANTHROPIC_API_KEY'}, Google API: ${googleConfigured() ? 'настроен' : 'не настроен'}, Telegram: ${telegramInfo().configured ? `статистика в ${telegramInfo().daily_time}` : 'не настроен'})`);
  processPending();
  startTelegram();
});
