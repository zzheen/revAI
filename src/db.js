// Хранилище на встроенном в Node.js SQLite (node:sqlite), без нативных зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || 'data/revai.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  services TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '',
  stop_words TEXT NOT NULL DEFAULT '',
  google_location TEXT NOT NULL DEFAULT '',  -- accounts/{id}/locations/{id}
  yandex_org_url TEXT NOT NULL DEFAULT '',   -- ссылка на карточку в Яндекс Картах
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('google', 'yandex')),
  external_id TEXT,
  author TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,               -- ISO 8601
  sentiment TEXT,                         -- positive | neutral | negative
  topic TEXT,
  urgency TEXT,                           -- low | medium | high
  draft_reply TEXT,
  ai_engine TEXT,                         -- claude | heuristic
  status TEXT NOT NULL DEFAULT 'new',     -- new | draft_ready | approved
  approved_at TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS reviews_created ON reviews(created_at);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,                -- ISO 8601, локальное время
  duration_min INTEGER NOT NULL DEFAULT 60,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS meetings_starts ON meetings(starts_at);
`);

// Миграции для баз, созданных прошлой версией
const addColumn = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumn('clients', 'google_maps_url', "TEXT NOT NULL DEFAULT ''"); // ссылка на место в Google Картах (для парсера)
addColumn('reviews', 'owner_reply', "TEXT NOT NULL DEFAULT ''");    // ответ организации, уже опубликованный на площадке
addColumn('meetings', 'source', "TEXT NOT NULL DEFAULT 'web'");     // web | telegram (голос/текст) | chat (из переписки)
addColumn('reviews', 'date_approx', 'INTEGER NOT NULL DEFAULT 0');   // 1: Google отдал только «3 месяца назад»

export const SLA_HOURS = Number(process.env.SLA_HOURS || 24);

// Статус «просрочен» вычисляется: отзыв не одобрен дольше SLA.
// Отзыв, на который организация уже ответила на площадке, не просрочен.
export function withOverdue(r) {
  if (!r) return r;
  const ageH = (Date.now() - Date.parse(r.created_at)) / 36e5;
  const answered = r.status !== 'approved' && Boolean(r.owner_reply);
  const overdue = r.status !== 'approved' && !answered && ageH > SLA_HOURS;
  return { ...r, overdue, display_status: overdue ? 'overdue' : answered ? 'answered' : r.status };
}

export function insertReview(r) {
  const res = db.prepare(`
    INSERT INTO reviews (client_id, source, external_id, author, rating, text, created_at, owner_reply, date_approx)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, external_id) DO NOTHING
  `).run(r.client_id, r.source, r.external_id ?? null, r.author ?? '', r.rating ?? null, r.text ?? '', r.created_at, r.owner_reply ?? '', r.date_approx ? 1 : 0);
  return res.changes ? Number(res.lastInsertRowid) : null;
}
