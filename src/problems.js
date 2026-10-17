// Разбор плохих отзывов по видам проблем, чтобы руководитель видел, что именно болит.
// Плохой отзыв: оценка 3 и ниже, либо ИИ отметил негатив. Один отзыв может попасть в несколько проблем.
export const PROBLEMS = [
  { key: 'food', title: 'Кухня и вкус', re: /невкусн|не вкусн|безвкусн|пересол|недосол|жирн|пережар|подгор|пригор|сыр(ой|ые|ая)|полусыр|холодн(ое|ые|ый|ая)|кухня (испорт|слаб)|еда (так себе|не вау|кошмар)|кухня не|не свеж|испортил|послевкус|гореч|ни ?как|было вкуснее|залит\w* масл|не хрустящ|резинов|пресн|не доготов/i },
  { key: 'staff', title: 'Официанты и сервис', re: /официант|обслуж|персонал|хам|груб|невежлив|не вежлив|администратор|пассивн|равнодуш|не подход|игнор|торопят|бросают|не ждут|недовол|фыркн/i },
  { key: 'wait', title: 'Долгое ожидание', re: /долго|ждал|ждали|жд[её]шь|ожидан|час(а)? ждал|\d+\s*мин|не дожд|медленн/i },
  { key: 'price', title: 'Цены и счёт', re: /дорог|цен[аыу]|космич|не оправдан|неоправдан|переплат|сервисн\w* сбор|в чеке|лишн\w* позиц|обсчит|счет|счёт/i },
  { key: 'hygiene', title: 'Гигиена и чистота', re: /волос|грязн|антисанитар|таракан|муха|чистот|отравл|несвеж|не стерил|туалет/i },
  { key: 'menu', title: 'Меню и порции', re: /скудн|меню (бедн|маленьк|скудн)|порци|мало (выбор|ягод)|5 штуч|нет в наличии|закончил/i },
  { key: 'comfort', title: 'Атмосфера и комфорт', re: /(?<![а-яё])(дует|холодно в зал|шумн|громк|курят|курение|дым|табачн|душно|тесно|wi-?fi|связь|парковк|музык)/i },
];

export const isBad = (r) => (r.rating != null && r.rating <= 3) || r.sentiment === 'negative';

export function classify(text) {
  const t = String(text || '');
  const hits = PROBLEMS.filter((p) => p.re.test(t)).map((p) => p.key);
  return hits.length ? hits : ['other'];
}

// Короткая цитата вокруг первого совпадения, чтобы суть жалобы была видна без чтения всего отзыва.
export function quote(text, key) {
  const p = PROBLEMS.find((x) => x.key === key);
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = p && t.match(p.re);
  if (!m || t.length <= 220) return t.slice(0, 220);
  const start = Math.max(0, m.index - 90);
  return `${start ? '…' : ''}${t.slice(start, start + 220)}${start + 220 < t.length ? '…' : ''}`;
}

export function problemsReport(rows) {
  const bad = rows.filter(isBad).map((r) => ({ ...r, problems: classify(r.text) }));
  const months = [...new Set(rows.map((r) => r.created_at.slice(0, 7)))].sort();
  const cats = [...PROBLEMS.map(({ key, title }) => ({ key, title })), { key: 'other', title: 'Без явной причины' }].map((c) => {
    const list = bad.filter((r) => r.problems.includes(c.key));
    return {
      ...c,
      count: list.length,
      share: bad.length ? Math.round((list.length / bad.length) * 100) : 0,
      by_month: months.map((m) => list.filter((r) => r.created_at.startsWith(m)).length),
      last_at: list.length ? list.reduce((a, r) => (r.created_at > a ? r.created_at : a), '') : null,
      examples: list.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3).map((r) => ({ id: r.id, rating: r.rating, created_at: r.created_at, quote: quote(r.text, c.key) })),
    };
  }).filter((c) => c.count).sort((a, b) => b.count - a.count);

  const rated = rows.filter((r) => r.rating != null);
  return {
    total: rows.length,
    bad: bad.length,
    bad_share: rows.length ? +((bad.length / rows.length) * 100).toFixed(1) : 0,
    avg_rating: rated.length ? +(rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(2) : null,
    unanswered: bad.filter((r) => !r.owner_reply && r.status !== 'approved').length,
    months,
    bad_by_month: months.map((m) => bad.filter((r) => r.created_at.startsWith(m)).length),
    total_by_month: months.map((m) => rows.filter((r) => r.created_at.startsWith(m)).length),
    categories: cats,
    reviews: bad.sort((a, b) => b.created_at.localeCompare(a.created_at)),
  };
}
