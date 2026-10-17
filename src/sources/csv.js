// Импорт отзывов из CSV. Основной путь для Яндекса: у Яндекс Карт / Яндекс Бизнеса
// нет публичного API для чтения отзывов, поэтому отзывы выгружаются в CSV
// (вручную или сервисом-агрегатором) и загружаются сюда. Подходит и для Google.
import { createHash } from 'node:crypto';

// Разбор CSV с кавычками, разделитель , или ; определяется по заголовку.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const ALIASES = {
  source: ['source', 'источник', 'площадка'],
  date: ['date', 'дата', 'created_at', 'дата и время'],
  author: ['author', 'автор', 'имя'],
  rating: ['rating', 'оценка', 'рейтинг', 'звёзды', 'звезды'],
  text: ['text', 'текст', 'отзыв', 'comment'],
  id: ['id', 'review_id', 'external_id'],
};

// Дата по ТЗ: «ДД.ММ.ГГГГ ЧЧ:ММ»; ISO тоже принимаем.
export function parseDate(s) {
  s = (s || '').trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 12), +(m[5] || 0));
    return isNaN(d) ? null : d.toISOString();
  }
  const d = new Date(s);
  return s && !isNaN(d) ? d.toISOString() : null;
}

export function reviewsFromCsv(text, defaultSource) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('В CSV нет строк с отзывами');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.text < 0 || col.date < 0) throw new Error('Нужны колонки «дата» и «текст» (или date и text)');

  const reviews = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
    const srcRaw = get('source').toLowerCase();
    const source = /google|гугл/.test(srcRaw) ? 'google' : /yandex|яндекс/.test(srcRaw) ? 'yandex' : defaultSource;
    const created_at = parseDate(get('date'));
    const text = get('text');
    const rating = get('rating') ? Number(get('rating').replace(',', '.')) : null;
    if (!created_at) return errors.push(`строка ${line}: дата не в формате ДД.ММ.ГГГГ ЧЧ:ММ`);
    if (text.length > 3000) return errors.push(`строка ${line}: текст длиннее 3000 символов`);
    if (rating != null && !(rating >= 1 && rating <= 5)) return errors.push(`строка ${line}: оценка должна быть от 1 до 5`);
    const author = get('author');
    const external_id = get('id') || createHash('sha1').update(`${source}|${created_at}|${author}|${text}`).digest('hex').slice(0, 20);
    reviews.push({ source, external_id, author, rating: rating == null ? null : Math.round(rating), text, created_at });
  });
  return { reviews, errors };
}
