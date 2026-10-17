// Распознавание встречи из свободного текста: «завтра в 15:00 созвон с Матрёшкой на час».
// С ANTHROPIC_API_KEY разбирает Claude (понимает контекст переписки), без ключа работает
// простой разбор русских дат и времени.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// ---------- Разбор без ИИ ----------
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const WEEKDAYS = [['воскресень', 0], ['понедельник', 1], ['вторник', 2], ['сред', 3], ['четверг', 4], ['пятниц', 5], ['суббот', 6]];
export const MEETING_WORDS = /встреч|встрет|созвон|звонок|позвон|планерк|переговор|совещан|увидимся|зум|zoom|телемост|видеосвяз|приеду|подъеду|заеду|собрани|презентаци|обсуд/;

function parseDate(t, now) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const add = (days) => { const d = new Date(base); d.setDate(d.getDate() + days); return d; };
  if (/послезавтра/.test(t)) return add(2);
  if (/завтра/.test(t)) return add(1);
  if (/сегодня/.test(t)) return add(0);
  let m = t.match(/через (\d+|неделю|день|два|три) ?(дн|дня|день|недел)?/);
  if (m) {
    const n = { неделю: 7, день: 1, два: 2, три: 3 }[m[1]] ?? Number(m[1]);
    return add(/недел/.test(m[2] || '') && m[1] !== 'неделю' ? n * 7 : n);
  }
  m = t.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
  if (m && !/\d{1,2}\.\d{2}\s*(утра|вечера|дня)/.test(m[0])) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && d < base) d.setFullYear(y + 1);
    if (Number(m[2]) <= 12) return d;
  }
  m = t.match(new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`));
  if (m) {
    const mi = MONTHS.findIndex((x) => new RegExp(`^${x}`).test(m[2]));
    const d = new Date(now.getFullYear(), mi, Number(m[1]));
    if (d < base) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  const wd = WEEKDAYS.find(([w]) => new RegExp(`(во?|на|к|в эт\\S*|в следующ\\S*)\\s+${w}`).test(t) || new RegExp(`^${w}`).test(t));
  if (wd) {
    // Ближайший такой день недели; если он сегодня — через неделю.
    return add((wd[1] - base.getDay() + 7) % 7 || 7);
  }
  return null;
}

function parseTime(t) {
  if (/в полдень/.test(t)) return '12:00';
  // «в 15:00», «в 14.30», «к 9-30», «в 3 часа дня», «в 11 утра», «в 11» (часы без минут)
  const m = t.match(/(?:^|\s)(?:в|к|с)\s*(\d{1,2})(?:[:.\-](\d{2}))?(?:\s*(часа|часов|час|ч)(?![а-я]))?(?:\s*(утра|дня|вечера|ночи))?(?=$|[\s,.!?)])/)
    || t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0), part = m[4] || '';
  // Без минут, «часов» и части суток это может быть что угодно («в 2 раза»), не считаем временем
  if (!m[2] && !m[3] && !part && !(h >= 8 && h <= 21)) return null;
  if (/вечера|дня/.test(part) && h < 12) h += 12;
  if (part === 'утра' && h === 12) h = 0;
  // «в 3 часа» без уточнения в рабочем контексте — это день
  if (!part && !m[2] && h >= 1 && h <= 7) h += 12;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function parseDuration(t) {
  let m;
  if (/полтора часа/.test(t)) return 90;
  if ((m = t.match(/на (\d+)\s*(час|ч(?![а-я]))/))) return Number(m[1]) * 60;
  if (/на час/.test(t)) return 60;
  if ((m = t.match(/на (\d+)\s*мин/))) return Number(m[1]);
  if (/на полчаса/.test(t)) return 30;
  return 60;
}

function findClient(t, clients) {
  const words = (c) => norm(c.name).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4);
  // «Матрёшка» → «матрешк», чтобы совпадали падежи: «с Матрёшкой», «в Матрёшке»
  return clients.find((c) => words(c).some((w) => t.includes(w.slice(0, Math.max(4, w.length - 2))))) || null;
}

// Тема без даты, времени и служебных слов: «завтра в 15:00 встреча с Матрёшкой» → «Встреча с Матрёшкой»
function cleanTitle(text) {
  const s = String(text).replace(/\s+/g, ' ')
    .replace(/(^|\s)(отлично|хорошо|ок|ok|тогда|давайте|давай|поставь|запиши|добавь|внеси|напомни|пожалуйста|нужно|надо)[,!]?(?=\s|$)/gi, ' ')
    .replace(/(^|\s)(сегодня|завтра|послезавтра|через \S+ (дн\S*|недел\S*)|через неделю)(?=\s|$|[,.!?])/gi, ' ')
    .replace(/(^|\s)(в|во|на|к|в эт\S*|в следующ\S*)\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?=\s|$|[,.!?])/gi, ' ')
    .replace(/(^|\s)(в|к|с)\s*\d{1,2}([:.\-]\d{2})?(\s*(часа|часов|час|ч))?(\s*(утра|дня|вечера|ночи))?(?=\s|$|[,.!?])/gi, ' ')
    .replace(/(^|\s)\d{1,2}(\.\d{1,2}(\.\d{2,4})?|\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*)(?=\s|$|[,.!?])/gi, ' ')
    .replace(/(^|\s)на (\d+\s*)?(час\S*|минут\S*|мин|полчаса)|полтора часа/gi, ' ')
    .replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.!?-]+|[\s,.!?-]+$/g, '').replace(/\s+/g, ' ');
  return s ? (s[0].toUpperCase() + s.slice(1)).slice(0, 120) : 'Встреча';
}

export function heuristicMeeting(text, { now = new Date(), clients = [], mode = 'direct' } = {}) {
  const t = norm(text);
  const date = parseDate(t, now), time = parseTime(t);
  const words = MEETING_WORDS.test(t);
  const is_meeting = mode === 'direct' ? Boolean(date || time) : Boolean(words && (date || time));
  const c = findClient(t, clients);
  const title = cleanTitle(text);
  return {
    is_meeting,
    title: title || 'Встреча',
    date: date ? ymd(date) : time ? ymd(now) : '',
    time: time || '',
    duration_min: parseDuration(t),
    client: c?.name || '',
    notes: '',
    confidence: date && time ? 'high' : date || time ? 'medium' : 'low',
    engine: 'heuristic',
  };
}

// ---------- Разбор через Claude ----------
const SCHEMA = {
  type: 'object',
  properties: {
    is_meeting: { type: 'boolean', description: 'true, если договорились или просят назначить конкретную встречу/созвон' },
    title: { type: 'string', description: 'Короткая тема встречи по-русски, до 80 символов' },
    date: { type: 'string', description: 'Дата в формате YYYY-MM-DD или пустая строка, если дата не названа' },
    time: { type: 'string', description: 'Время HH:MM (24 часа) или пустая строка, если время не названо' },
    duration_min: { type: 'integer', description: 'Длительность в минутах, 60 если не сказано' },
    client: { type: 'string', description: 'Название клиента из списка, если речь о нём, иначе пустая строка' },
    notes: { type: 'string', description: 'Важные детали: место, участники, что подготовить. Пусто, если нет' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['is_meeting', 'title', 'date', 'time', 'duration_min', 'client', 'notes', 'confidence'],
  additionalProperties: false,
};

const SYSTEM = `Ты ассистент руководителя агентства. Тебе присылают голосовые (уже переведённые в текст), сообщения руководителя или фрагменты рабочих переписок.
Найди в них встречу, которую нужно внести в календарь: созвон, встреча, переговоры, планёрка.
- Относительные даты («завтра», «в пятницу», «через неделю») переводи в точную дату от текущей даты из запроса.
- «В 3» без уточнения в рабочем контексте — это 15:00.
- В переписке встреча считается назначенной, только если участники договорились о времени или прямо просят его зарезервировать. Обсуждение без конкретики — is_meeting false.
- Клиента выбирай только из переданного списка.
- Ничего не придумывай: если даты или времени нет, оставь поле пустым.`;

async function claudeMeeting(text, { now, clients, mode, context }) {
  const today = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: `Сейчас: ${today}, ${pad(now.getHours())}:${pad(now.getMinutes())} (${ymd(now)}).
Клиенты: ${clients.map((c) => c.name).join('; ') || 'нет'}.
${mode === 'direct' ? 'Руководитель сам написал боту, чтобы занести встречу.' : 'Это фрагмент переписки, бот её читает фоном.'}
${context?.length ? `Предыдущие сообщения чата:\n${context.join('\n')}\n\n` : ''}Сообщение:\n${text}`,
    }],
  };
  let res;
  try {
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    res = await client.messages.create(params);
  }
  if (res.stop_reason === 'refusal') throw new Error('Модель отказалась разбирать сообщение');
  const out = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { ...out, engine: 'claude' };
}

export async function extractMeeting(text, opts = {}) {
  const o = { now: new Date(), clients: [], mode: 'direct', ...opts };
  if (client) {
    try {
      const out = await claudeMeeting(text, o);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) out.date = '';
      if (!/^\d{2}:\d{2}$/.test(out.time)) out.time = '';
      out.duration_min = Math.min(Math.max(Number(out.duration_min) || 60, 5), 720);
      return out;
    } catch (e) {
      console.error(`Разбор встречи через Claude: ${e.message}, использую простой разбор`);
    }
  }
  return heuristicMeeting(text, o);
}
