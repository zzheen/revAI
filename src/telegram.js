// Telegram-бот руководителя: ежедневная статистика по отзывам и встречи в календарь
// (голосовым, текстом или из переписок, куда добавлен бот).
// Работает напрямую через Telegram Bot API (без библиотек), long polling.
// .env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID (можно несколько через запятую), TELEGRAM_DAILY_TIME (ЧЧ:ММ, по времени сервера).
import { fetch as ufetch, ProxyAgent } from 'undici';
import { db, withOverdue } from './db.js';
import { extractMeeting, MEETING_WORDS } from './meetings-ai.js';
import { transcribe, sttConfigured, STT_MAX_SECONDS } from './stt.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
// Если api.telegram.org недоступен напрямую (блокировка у провайдера), запросы идут через HTTP-прокси:
// TELEGRAM_PROXY=http://127.0.0.1:10809 (адрес локального прокси вашего VPN-клиента).
const PROXY = process.env.TELEGRAM_PROXY || '';
const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;
const ADMINS = (process.env.TELEGRAM_ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const DAILY_TIME = /^\d{1,2}:\d{2}$/.test(process.env.TELEGRAM_DAILY_TIME || '') ? process.env.TELEGRAM_DAILY_TIME : '20:00';

export const telegramConfigured = () => Boolean(TOKEN && ADMINS.length);
export const telegramInfo = () => ({ configured: telegramConfigured(), token: Boolean(TOKEN), admins: ADMINS.length, daily_time: DAILY_TIME });

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

async function tg(method, body) {
  let res;
  try {
    res = await ufetch(`${API}/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`Telegram недоступен (${cause}). ${PROXY
      ? `Проверьте, что прокси ${PROXY} работает.`
      : 'Похоже, api.telegram.org заблокирован у провайдера: включите VPN на весь компьютер или укажите TELEGRAM_PROXY в .env (см. README).'}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const avg = (rows) => {
  const r = rows.filter((x) => x.rating != null);
  return r.length ? (r.reduce((a, x) => a + x.rating, 0) / r.length).toFixed(2) : '—';
};

// Текст статистики за день (по местному времени сервера).
export function dailyReport(date = new Date()) {
  const from = dayStart(date), to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  const prevFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const q = db.prepare('SELECT r.*, c.name AS client_name FROM reviews r JOIN clients c ON c.id = r.client_id WHERE r.created_at >= ? AND r.created_at < ?');
  const rows = q.all(from.toISOString(), to.toISOString()).map(withOverdue);
  const prevCount = q.all(prevFrom.toISOString(), from.toISOString()).length;
  const all = db.prepare("SELECT * FROM reviews WHERE status != 'approved'").all().map(withOverdue);
  const approvedToday = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE approved_at >= ? AND approved_at < ?')
    .get(from.toISOString().replace('T', ' ').slice(0, 19), to.toISOString().replace('T', ' ').slice(0, 19)).n;

  const count = (fn) => rows.filter(fn).length;
  const g = rows.filter((r) => r.source === 'google'), y = rows.filter((r) => r.source === 'yandex');
  const diff = rows.length - prevCount;
  const lines = [
    `📊 <b>Отзывы за ${from.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</b>`,
    '',
    `Всего: <b>${rows.length}</b> (вчера ${prevCount}${diff ? `, ${diff > 0 ? '+' : ''}${diff}` : ''})`,
    `Средняя оценка: <b>${avg(rows)}</b>`,
    `Google: ${g.length}, ★ ${avg(g)}`,
    `Яндекс: ${y.length}, ★ ${avg(y)}`,
    '',
    `🟢 позитив: ${count((r) => r.sentiment === 'positive')}`,
    `🟡 нейтрально: ${count((r) => r.sentiment === 'neutral')}`,
    `🔴 негатив: ${count((r) => r.sentiment === 'negative')}`,
  ];

  const topics = {};
  rows.forEach((r) => r.topic && (topics[r.topic] = (topics[r.topic] || 0) + 1));
  const top = Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push('', `Темы: ${top.map(([t, n]) => `${esc(t)} (${n})`).join(', ')}`);

  const clients = {};
  rows.forEach((r) => (clients[r.client_name] ||= []).push(r));
  if (Object.keys(clients).length > 1) {
    lines.push('', '<b>По клиентам</b>');
    Object.entries(clients).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
      .forEach(([name, l]) => lines.push(`• ${esc(name)}: ${l.length}, ★ ${avg(l)}, негатив ${l.filter((r) => r.sentiment === 'negative').length}`));
  }

  lines.push('', '<b>Ответы</b>',
    `Одобрено за день: ${approvedToday}`,
    `Сейчас ждут проверки: ${all.filter((r) => r.status === 'draft_ready' && !r.owner_reply).length}`,
    `В очереди ИИ: ${all.filter((r) => r.status === 'new' && !r.owner_reply).length}`,
    `⏰ Просрочено по SLA: <b>${all.filter((r) => r.overdue).length}</b>`);

  const neg = rows.filter((r) => r.sentiment === 'negative').slice(0, 5);
  if (neg.length) {
    lines.push('', '<b>Негативные отзывы</b>');
    neg.forEach((r) => {
      const t = r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text;
      lines.push(`• ${r.source === 'google' ? 'Google' : 'Яндекс'}, ${r.rating ?? '—'}★, ${esc(r.client_name)}: «${esc(t)}»`);
    });
  }
  return lines.join('\n');
}

export async function sendDailyReport(date = new Date()) {
  if (!telegramConfigured()) throw new Error('Telegram не настроен: заполните TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_ID в .env');
  const text = dailyReport(date);
  for (const id of ADMINS) await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return { sent_to: ADMINS.length };
}

// Раз в 30 секунд проверяем, не пора ли отправить. Дата последней отправки хранится в БД,
// поэтому перезапуск сервера не приводит к повторной отправке.
async function tick() {
  const now = new Date();
  const [h, m] = DAILY_TIME.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  if (getSetting('telegram_last_daily') === ymd(now)) return;
  setSetting('telegram_last_daily', ymd(now));
  try {
    await sendDailyReport(now);
    console.log(`Telegram: дневная статистика отправлена (${ymd(now)})`);
  } catch (e) {
    setSetting('telegram_last_daily', '');
    console.error(e.message);
  }
}

// ---------- Встречи из Telegram ----------
// Бот предлагает встречу с кнопками «Добавить / Не нужно», в календарь она попадает только после подтверждения.
db.exec(`CREATE TABLE IF NOT EXISTS meeting_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  dedup TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | added | rejected
  meeting_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const clientsList = () => db.prepare('SELECT id, name FROM clients ORDER BY name').all();
const fmtWhen = (date, time) => `${new Date(`${date}T12:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}, ${time}`;
const shortClient = (name) => String(name).replace(/\s*\(.*\)\s*$/, '');

function conflicts(date, time, duration) {
  const start = Date.parse(`${date}T${time}`), end = start + duration * 6e4;
  return db.prepare('SELECT * FROM meetings WHERE starts_at LIKE ?').all(`${date}%`)
    .filter((m) => { const s = Date.parse(m.starts_at); return s < end && s + m.duration_min * 6e4 > start; });
}

async function proposeMeeting(chatIds, m, origin) {
  const c = clientsList().find((x) => x.name === m.client);
  const busy = conflicts(m.date, m.time, m.duration_min);
  const draft = { ...m, client_id: c?.id ?? null, origin };
  const id = Number(db.prepare('INSERT INTO meeting_drafts (data, dedup) VALUES (?, ?)').run(JSON.stringify(draft), origin.dedup || '').lastInsertRowid);
  const text = [
    `📅 <b>${origin.kind === 'chat' ? 'Похоже, договорились о встрече' : 'Добавить встречу?'}</b>`,
    '',
    `<b>${esc(m.title)}</b>`,
    `🕒 ${esc(fmtWhen(m.date, m.time))}, ${m.duration_min} мин`,
    c ? `👤 ${esc(shortClient(c.name))}` : '',
    m.notes ? `📝 ${esc(m.notes)}` : '',
    origin.label ? `\n<i>${esc(origin.label)}</i>` : '',
    busy.length ? `\n⚠️ В это время уже есть: ${busy.map((b) => `${b.starts_at.slice(11)} ${esc(b.title)}`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  for (const chat_id of chatIds) {
    await tg('sendMessage', {
      chat_id, text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '✅ Добавить в календарь', callback_data: `m_ok:${id}` }, { text: '✖ Не нужно', callback_data: `m_no:${id}` }]] },
    });
  }
}

async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const res = await ufetch(`${API}/file/bot${TOKEN}/${f.file_path}`, { dispatcher, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Telegram: не удалось скачать файл (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Сообщение руководителя боту в личку: текст, пересланное сообщение или голосовое.
async function meetingFromDirect(msg, reply) {
  let text = msg.text || msg.caption || '';
  let label = msg.forward_origin ? 'Из пересланного сообщения' : '';
  const voice = msg.voice || msg.audio;
  if (voice) {
    if (!sttConfigured()) return reply('Голосовые пока не распознаются: нужен ключ YANDEX_SPEECHKIT_API_KEY в .env (инструкция в README). Напишите встречу текстом, например: «завтра в 15:00 созвон с Матрёшкой».');
    if (voice.duration > STT_MAX_SECONDS) return reply(`Голосовое длиннее ${STT_MAX_SECONDS} секунд, столько распознать не могу. Запишите короче или напишите текстом.`);
    text = await transcribe(await downloadFile(voice.file_id));
    if (!text) return reply('Не разобрал голосовое, попробуйте ещё раз.');
    label = `Голосовое: «${text}»`;
  }
  if (!text.trim()) return;
  const m = await extractMeeting(text, { clients: clientsList(), mode: 'direct' });
  if (!m.is_meeting || !m.date || !m.time) {
    return reply(`${voice ? `Распознал: «${esc(text)}»\n\n` : ''}Не нашёл ${!m.date && !m.time ? 'дату и время' : !m.time ? 'время' : 'дату'} встречи. Например: «завтра в 15:00 встреча с Матрёшкой на час» или «в пятницу в 11 созвон по отзывам».`);
  }
  return proposeMeeting([String(msg.chat.id)], m, { kind: voice ? 'voice' : 'text', label });
}

// Переписки: группы, куда добавлен бот, и личные чаты руководителя через Telegram Business.
const chatContext = new Map();
async function meetingFromChat(msg, kind) {
  const text = msg.text || msg.caption || '';
  if (!text) return;
  const chatKey = `${kind}:${msg.chat.id}`;
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Участник';
  const ctx = chatContext.get(chatKey) || [];
  ctx.push(`${who}: ${text.slice(0, 500)}`);
  chatContext.set(chatKey, ctx.slice(-8));
  // Дешёвый фильтр: ИИ зовём, только если в сообщении есть слова о встрече или время/дата
  const t = text.toLowerCase().replace(/ё/g, 'е');
  if (!MEETING_WORDS.test(t) && !/\d{1,2}[:.]\d{2}|завтра|сегодня|понедельник|вторник|сред[уа]|четверг|пятниц|суббот|воскресень/.test(t)) return;
  const m = await extractMeeting(text, { clients: clientsList(), mode: 'chat', context: ctx.slice(0, -1) });
  if (!m.is_meeting || !m.date || !m.time || m.confidence === 'low') return;
  const dedup = `${chatKey}|${m.date}|${m.time}`;
  if (db.prepare("SELECT 1 FROM meeting_drafts WHERE dedup = ? AND created_at > datetime('now', '-1 day')").get(dedup)) return;
  const chatName = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || 'чат';
  await proposeMeeting(ADMINS, m, { kind: 'chat', dedup, label: `Из ${kind === 'business' ? 'переписки с' : 'чата'} «${chatName}», написал(а) ${who}: «${text.slice(0, 200)}»` });
}

async function handleCallback(cq) {
  const fromId = String(cq.from.id);
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  if (!ADMINS.includes(fromId)) return answer('Только для администратора');
  const [action, id] = String(cq.data || '').split(':');
  const row = db.prepare('SELECT * FROM meeting_drafts WHERE id = ?').get(id);
  if (!row) return answer('Предложение не найдено');
  if (row.status !== 'pending') return answer(row.status === 'added' ? 'Уже в календаре' : 'Уже отклонено');
  const d = JSON.parse(row.data);
  const edit = (text) => tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text, parse_mode: 'HTML' }).catch(() => {});
  if (action === 'm_ok') {
    const r = db.prepare('INSERT INTO meetings (client_id, title, starts_at, duration_min, notes, source) VALUES (?,?,?,?,?,?)')
      .run(d.client_id, d.title.slice(0, 200), `${d.date}T${d.time}`, d.duration_min, [d.notes, d.origin?.label].filter(Boolean).join('\n').slice(0, 2000), d.origin?.kind === 'chat' ? 'chat' : 'telegram');
    db.prepare("UPDATE meeting_drafts SET status = 'added', meeting_id = ? WHERE id = ?").run(Number(r.lastInsertRowid), id);
    await edit(`✅ <b>В календаре:</b> ${esc(d.title)}\n🕒 ${esc(fmtWhen(d.date, d.time))}, ${d.duration_min} мин`);
    return answer('Добавлено');
  }
  db.prepare("UPDATE meeting_drafts SET status = 'rejected' WHERE id = ?").run(id);
  await edit(`✖ <s>${esc(d.title)}</s> — не добавлено`);
  return answer('Не добавлено');
}

function upcoming(days) {
  const now = new Date(), to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const list = db.prepare('SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON c.id = m.client_id WHERE m.starts_at >= ? AND m.starts_at < ? ORDER BY m.starts_at')
    .all(`${ymd(now)}T00:00`, `${ymd(to)}T00:00`);
  if (!list.length) return days === 1 ? 'Сегодня встреч нет.' : 'На ближайшую неделю встреч нет.';
  let day = '';
  return [days === 1 ? '📅 <b>Встречи сегодня</b>' : '📅 <b>Встречи на 7 дней</b>', ...list.flatMap((m) => {
    const d = m.starts_at.slice(0, 10), out = [];
    if (d !== day && days > 1) { day = d; out.push('', `<b>${esc(new Date(`${d}T12:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>`); }
    out.push(`${m.starts_at.slice(11)} · ${esc(m.title)}${m.client_name ? ` (${esc(shortClient(m.client_name))})` : ''}`);
    return out;
  })].join('\n');
}

// Команды: /id (любому, чтобы узнать свой id), остальное только администраторам.
async function handle(msg) {
  const chatId = String(msg.chat.id), fromId = String(msg.from?.id ?? '');
  const isPrivate = msg.chat.type === 'private';
  if (!isPrivate) return meetingFromChat(msg, 'group');
  const cmd = (msg.text || '').trim().split(/[\s@]/)[0].toLowerCase();
  const isAdmin = ADMINS.includes(chatId) || ADMINS.includes(fromId);
  const reply = (text) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  if (cmd === '/id' || cmd === '/start' || cmd === '/help') {
    return reply(`Ваш Telegram id: <code>${esc(fromId)}</code>\nId этого чата: <code>${esc(chatId)}</code>\n\n${isAdmin
      ? `Вы администратор.\n\n<b>Встречи.</b> Отправьте голосовое или текст, например «завтра в 15:00 встреча с Матрёшкой на час», или перешлите сообщение с договорённостью. Я предложу встречу, и после кнопки «Добавить» она появится в календаре.\nДобавьте меня в рабочий чат (или подключите в Telegram → Настройки → Telegram для бизнеса → Чат-боты), и я буду сам замечать договорённости о встречах.\n\n<b>Команды:</b> /today встречи сегодня, /week на 7 дней, /stats отзывы за сегодня, /yesterday за вчера.\nСтатистика по отзывам приходит каждый день в ${DAILY_TIME}.`
      : 'Чтобы пользоваться ботом, впишите этот id в TELEGRAM_ADMIN_ID в файле .env и перезапустите сервер.'}`);
  }
  if (!isAdmin) return;
  if (cmd === '/stats') return reply(dailyReport(new Date()));
  if (cmd === '/yesterday') return reply(dailyReport(new Date(Date.now() - 864e5)));
  if (cmd === '/today') return reply(upcoming(1));
  if (cmd === '/week' || cmd === '/meetings') return reply(upcoming(7));
  if (cmd.startsWith('/')) return;
  return meetingFromDirect(msg, reply);
}

async function poll() {
  let offset = 0, lastError = '';
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'business_message', 'business_connection'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const onErr = (e) => console.error(`Telegram: ${e.message}`);
        if (u.message) handle(u.message).catch(onErr);
        else if (u.callback_query) handleCallback(u.callback_query).catch(onErr);
        else if (u.business_message) meetingFromChat(u.business_message, 'business').catch(onErr);
        else if (u.business_connection) console.log(`Telegram Business: бот ${u.business_connection.is_enabled ? 'подключён к' : 'отключён от'} аккаунта ${u.business_connection.user?.first_name || ''}`);
      }
    } catch (e) {
      // Одна и та же ошибка печатается один раз, а не каждые 5 секунд.
      if (e.message !== lastError) console.error(e.message);
      lastError = e.message;
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (lastError) console.log('Telegram: связь восстановлена');
    lastError = '';
  }
}

export function startTelegram() {
  if (!TOKEN) return;
  tg('setMyCommands', {
    commands: [
      { command: 'today', description: 'Встречи сегодня' },
      { command: 'week', description: 'Встречи на 7 дней' },
      { command: 'stats', description: 'Статистика отзывов за сегодня' },
      { command: 'yesterday', description: 'Статистика за вчера' },
      { command: 'id', description: 'Узнать свой Telegram id' },
    ],
  }).catch((e) => console.error(e.message));
  poll();
  if (ADMINS.length) setInterval(tick, 30_000).unref();
}
