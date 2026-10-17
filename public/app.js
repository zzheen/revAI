// Веб-панель RevAI: календарь, очередь отзывов, статистика, клиенты, источники.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : 'без оценки');
const STATUS = { new: 'Новый', draft_ready: 'Черновик готов', approved: 'Одобрен', overdue: 'Просрочен', answered: 'Есть ответ на площадке' };
const SENT = { positive: 'позитив', neutral: 'нейтрально', negative: 'негатив' };
const URG = { low: 'низкая срочность', medium: 'средняя срочность', high: 'срочно' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const fail = (e) => alert(e.message);

const state = { clients: [], clientId: '', status: '', source: '' };

// ---------- Вкладки ----------
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  refresh();
}));
const activeTab = () => $('.tabs button.active').dataset.tab;
function refresh() {
  ({ rcal: renderReviewCalendar, mcal: renderMeetingCalendar, problems: renderProblems, reviews: renderReviews, stats: renderStats, clients: renderClients, import: renderImport })[activeTab()]().catch(fail);
}

// ---------- Клиенты (общий список) ----------
async function loadClients() {
  state.clients = await api('/api/clients');
  const opts = state.clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#clientFilter').innerHTML = `<option value="">Все клиенты</option>${opts}`;
  $('#clientFilter').value = state.clientId;
  $('#meetingForm [name=client_id]').innerHTML = `<option value="">Без клиента</option>${opts}`;
  $('#csvForm [name=client_id]').innerHTML = opts || '<option value="">Сначала добавьте клиента</option>';
}
$('#clientFilter').addEventListener('change', (e) => { state.clientId = e.target.value; refresh(); });

async function loadStatus() {
  const s = await api('/api/status');
  $('#statusBadge').textContent = `ИИ: ${s.ai ? 'Claude' : 'упрощённый режим'} · SLA ${s.sla_hours} ч`;
  $('#googleState').textContent = s.google ? 'Ключи Google найдены в .env.' : 'Ключи Google в .env не заданы, загрузка из Google пока недоступна.';
  $('#googleSync').disabled = !s.google;
  const t = s.telegram;
  $('#tgState').textContent = t.configured
    ? `Бот настроен, статистика уходит каждый день в ${t.daily_time} (время сервера), администраторов: ${t.admins}.`
    : !t.token ? 'TELEGRAM_BOT_TOKEN в .env не задан.' : 'Токен есть, но не задан TELEGRAM_ADMIN_ID. Напишите боту /id, он пришлёт ваш id.';
  $('#tgSend').disabled = !t.configured;
  const p = s.parser;
  $('#parserState').textContent = !p.browser ? 'Chrome или Edge не найден на этом компьютере, парсер не сможет работать.'
    : p.running ? 'Идёт загрузка отзывов…'
    : `${p.last_run ? `Последняя загрузка: ${fmtDate(p.last_run)}. ` : ''}${p.interval_hours > 0 ? `Автозагрузка каждые ${p.interval_hours} ч.` : 'Автозагрузка выключена.'}`;
  $('#mapsSync').disabled = !p.browser || p.running;
}

const mapsReport = (rep) => rep.length
  ? rep.map((r) => `${r.client} · ${r.source === 'google' ? 'Google' : 'Яндекс'}${r.place ? ` («${r.place}»)` : ''}: ${r.error ? `ошибка — ${r.error}` : `получено ${r.fetched}, новых ${r.added}`}${r.warning ? `\n  ⚠ ${r.warning}` : ''}`).join('\n')
  : 'Нет клиентов со ссылками на Яндекс или Google Карты. Добавьте ссылки во вкладке «Клиенты».';

// ---------- Календари (общая сетка) ----------
// Два независимых календаря: отзывов (по дате появления отзыва) и встреч.
const cal = {
  r: { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), selected: ymd(new Date()), byDay: {} },
  m: { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), selected: ymd(new Date()), byDay: {} },
};

function gridRange(m) {
  const from = new Date(m.getFullYear(), m.getMonth(), 1);
  const to = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  // Сетка с понедельника, включая хвосты соседних месяцев.
  const start = new Date(from); start.setDate(1 - ((from.getDay() + 6) % 7));
  const end = new Date(to); end.setDate(end.getDate() + ((7 - ((to.getDay() + 6) % 7)) % 7));
  return { from, to, start, end };
}

function drawGrid(gridEl, c, cellHtml) {
  const { from, start, end } = gridRange(c.month);
  const today = ymd(new Date());
  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const k = ymd(d);
    const { cls = '', body = '', extra = '' } = cellHtml(k, c.byDay[k]);
    const classes = ['day', cls, d.getMonth() !== from.getMonth() && 'other', k === today && 'today', k === c.selected && 'selected'].filter(Boolean).join(' ');
    html += `<div class="${classes}" data-day="${k}"><div class="num"><span>${d.getDate()}</span>${extra}</div>${body}</div>`;
  }
  gridEl.innerHTML = html;
}

const kpis = (el, items) => { el.innerHTML = items.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join(''); };
const avgOf = (list) => { const r = list.filter((x) => x.rating); return r.length ? r.reduce((a, x) => a + x.rating, 0) / r.length : null; };
const dayTitle = (k) => new Date(`${k}T12:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

// ---------- Календарь отзывов ----------
async function renderReviewCalendar() {
  const c = cal.r, { from, to, start, end } = gridRange(c.month);
  const q = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() });
  if (state.clientId) q.set('client_id', state.clientId);
  const reviews = await api(`/api/reviews?${q}`);
  c.byDay = {};
  reviews.forEach((r) => (c.byDay[ymd(new Date(r.created_at))] ||= []).push(r));
  $('#tab-rcal .cal-title').textContent = c.month.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });

  const inMonth = reviews.filter((r) => { const d = new Date(r.created_at); return d >= from && d < to; });
  const avg = avgOf(inMonth);
  kpis($('#rKpis'), [
    [inMonth.length, 'отзывов за месяц'],
    [avg ? avg.toFixed(2) : '—', 'средняя оценка'],
    [`${inMonth.filter((r) => r.source === 'yandex').length} / ${inMonth.filter((r) => r.source === 'google').length}`, 'Яндекс / Google'],
    [inMonth.filter((r) => r.sentiment === 'negative' || (r.rating && r.rating <= 2)).length, 'негативных'],
    [inMonth.filter((r) => r.overdue).length, 'просрочено по SLA'],
  ]);

  drawGrid($('#rGrid'), c, (k, rs = []) => {
    if (!rs.length) return {};
    const n = { positive: 0, neutral: 0, negative: 0 };
    rs.forEach((r) => { const s = r.sentiment || (r.rating >= 4 ? 'positive' : r.rating === 3 ? 'neutral' : r.rating ? 'negative' : 'neutral'); n[s]++; });
    const pct = (x) => (x / rs.length) * 100;
    const late = rs.filter((r) => r.overdue).length, a = avgOf(rs);
    const ya = rs.filter((r) => r.source === 'yandex').length, g = rs.length - ya;
    return {
      extra: `${late ? `<span class="alert" title="Просрочено по SLA">!${late}</span>` : ''}${a ? `<span class="avg">★ ${a.toFixed(1)}</span>` : ''}`,
      body: `<div class="bar"><i style="width:${pct(n.positive)}%;background:var(--pos)"></i><i style="width:${pct(n.neutral)}%;background:var(--neu)"></i><i style="width:${pct(n.negative)}%;background:var(--neg)"></i></div>
        <div class="cnt">${rs.length} отз.</div><div class="src-mix">${[ya && `Я ${ya}`, g && `G ${g}`].filter(Boolean).join(' · ')}</div>`,
    };
  });
  renderReviewDay();
}

function renderReviewDay() {
  const k = cal.r.selected, list = cal.r.byDay[k] || [];
  $('#rDayTitle').textContent = dayTitle(k);
  $('#dayReviews').innerHTML = `<h4>Отзывы (${list.length})</h4>` + (list.length
    ? list.map((r) => `<div class="mini-review ${r.sentiment || ''}"><b>${r.source === 'google' ? 'Google' : 'Яндекс'}</b> · ${stars(r.rating)} · ${esc(r.author)}${r.date_approx ? ' <span class="muted" title="Google показывает только примерную дату">(дата примерная)</span>' : ''}<br>${esc(r.text) || '<span class="muted">(без текста)</span>'}<br><span class="muted">${STATUS[r.display_status]}${r.topic ? ` · ${esc(r.topic)}` : ''}</span></div>`).join('')
    : '<p class="muted">Отзывов нет</p>');
}

$('#rGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.day');
  if (!cell) return;
  cal.r.selected = cell.dataset.day;
  $$('#rGrid .day').forEach((x) => x.classList.toggle('selected', x === cell));
  renderReviewDay();
});

// ---------- Календарь встреч ----------
async function renderMeetingCalendar() {
  const c = cal.m, { from, start, end } = gridRange(c.month);
  const q = new URLSearchParams({ from: ymd(start), to: ymd(end) });
  if (state.clientId) q.set('client_id', state.clientId);
  const meetings = await api(`/api/meetings?${q}`);
  c.byDay = {};
  meetings.forEach((m) => (c.byDay[m.starts_at.slice(0, 10)] ||= []).push(m));
  $('#tab-mcal .cal-title').textContent = c.month.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });

  const month = ymd(from).slice(0, 7), now = new Date();
  const inMonth = meetings.filter((m) => m.starts_at.slice(0, 7) === month);
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);
  const upcoming = meetings.filter((m) => { const d = new Date(m.starts_at); return d >= now && d < weekEnd; });
  kpis($('#mKpis'), [
    [inMonth.length, 'встреч за месяц'],
    [upcoming.length, 'на ближайшие 7 дней'],
    [inMonth.reduce((a, m) => a + m.duration_min, 0) ? `${Math.round(inMonth.reduce((a, m) => a + m.duration_min, 0) / 6) / 10} ч` : '0 ч', 'занято в месяце'],
    [new Set(inMonth.map((m) => m.client_id).filter(Boolean)).size, 'клиентов'],
    [upcoming[0] ? `${new Date(upcoming[0].starts_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${upcoming[0].starts_at.slice(11)}` : '—', 'следующая встреча'],
  ]);

  drawGrid($('#mGrid'), c, (k, ms = []) => ms.length ? {
    cls: 'busy',
    body: ms.slice(0, 3).map((m) => `<div class="chip" title="${esc(m.title)}">${m.starts_at.slice(11)} ${esc(m.title)}</div>`).join('') + (ms.length > 3 ? `<div class="chip">ещё ${ms.length - 3}</div>` : ''),
  } : {});
  renderMeetingDay();
}

function renderMeetingDay() {
  const k = cal.m.selected, list = cal.m.byDay[k] || [];
  $('#mDayTitle').textContent = dayTitle(k);
  $('#dayMeetings').innerHTML = list.length
    ? list.map((m) => `<div class="meeting"><div><b>${m.starts_at.slice(11)}</b> · ${m.duration_min} мин${m.source === 'telegram' ? ' · <span class="muted">из Telegram</span>' : m.source === 'chat' ? ' · <span class="muted">из переписки</span>' : ''}<br>${esc(m.title)}${m.client_name ? `<br><span class="muted">${esc(m.client_name)}</span>` : ''}${m.notes ? `<br><span class="muted">${esc(m.notes)}</span>` : ''}</div><button class="ghost" data-del="${m.id}" title="Удалить">×</button></div>`).join('')
    : '<p class="muted">Встреч нет</p>';
}

$('#mGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.day');
  if (!cell) return;
  cal.m.selected = cell.dataset.day;
  $$('#mGrid .day').forEach((x) => x.classList.toggle('selected', x === cell));
  renderMeetingDay();
});

$('#dayMeetings').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id || !confirm('Удалить встречу?')) return;
  await api(`/api/meetings/${id}`, { method: 'DELETE' }).catch(fail);
  renderMeetingCalendar().catch(fail);
});

// Разбор фразы → заполнение формы и переход на нужный день; сохраняет менеджер кнопкой «Добавить»
$('#quickMeeting').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = $('#quickHint'), btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const m = await api('/api/meetings/parse', { method: 'POST', body: { text: e.target.text.value } });
    if (!m.date || !m.time) { hint.textContent = `Не нашёл ${!m.date && !m.time ? 'дату и время' : !m.time ? 'время' : 'дату'}. Напишите, например: «в пятницу в 11:00 созвон».`; return; }
    const f = $('#meetingForm');
    f.title.value = m.title; f.time.value = m.time; f.duration_min.value = m.duration_min; f.notes.value = m.notes || '';
    const c = state.clients.find((x) => x.name === m.client);
    f.client_id.value = c ? c.id : '';
    cal.m.selected = m.date;
    const d = new Date(`${m.date}T12:00`);
    cal.m.month = new Date(d.getFullYear(), d.getMonth(), 1);
    await renderMeetingCalendar();
    hint.textContent = `Заполнил форму ниже: ${d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}, ${m.time}${c ? `, ${c.name}` : ''}. Проверьте и нажмите «Добавить».`;
    f.title.focus();
  } catch (err) { fail(err); } finally { btn.disabled = false; }
});

$('#meetingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/meetings', { method: 'POST', body: { title: f.title, starts_at: `${cal.m.selected}T${f.time}`, duration_min: f.duration_min, client_id: f.client_id || state.clientId || null, notes: f.notes } });
    e.target.title.value = ''; e.target.notes.value = '';
    await renderMeetingCalendar();
  } catch (err) { fail(err); }
});

// Листание месяцев в каждом календаре своё
for (const [key, render] of [['r', () => renderReviewCalendar()], ['m', () => renderMeetingCalendar()]]) {
  const sec = $(`[data-cal="${key}"]`), c = cal[key];
  $('.cal-prev', sec).onclick = () => { c.month = new Date(c.month.getFullYear(), c.month.getMonth() - 1, 1); render().catch(fail); };
  $('.cal-next', sec).onclick = () => { c.month = new Date(c.month.getFullYear(), c.month.getMonth() + 1, 1); render().catch(fail); };
  $('.cal-today', sec).onclick = () => { const n = new Date(); c.month = new Date(n.getFullYear(), n.getMonth(), 1); c.selected = ymd(n); render().catch(fail); };
}

// ---------- Проблемы ----------
const prob = { months: 12, cat: '', data: null };
const monthLabel = (m) => new Date(`${m}-15T12:00`).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });

async function renderProblems() {
  const q = new URLSearchParams();
  if (state.clientId) q.set('client_id', state.clientId);
  if (prob.months) { const d = new Date(); d.setMonth(d.getMonth() - prob.months, 1); d.setHours(0, 0, 0, 0); q.set('from', d.toISOString()); }
  const s = prob.data = await api(`/api/problems?${q}`);
  const top = s.categories.find((c) => c.key !== 'other');
  kpis($('#probKpis'), [
    [s.bad, 'плохих отзывов'],
    [`${s.bad_share}%`, `от всех ${s.total}`],
    [s.avg_rating ?? '—', 'средняя оценка'],
    [top ? esc(top.title) : '—', 'главная проблема'],
    [s.unanswered, 'плохих без ответа'],
  ]);
  const max = Math.max(1, ...s.bad_by_month);
  $('#probTrend').innerHTML = s.months.length ? `<div class="trend">${s.months.map((m, i) => `<div class="col" title="${monthLabel(m)}: плохих ${s.bad_by_month[i]} из ${s.total_by_month[i]}">
      <span class="n">${s.bad_by_month[i] || ''}</span><div class="b ${s.bad_by_month[i] ? '' : 'zero'}" style="height:${(s.bad_by_month[i] / max) * 80}%"></div><span class="m">${monthLabel(m)}</span></div>`).join('')}</div>` : '<p class="muted">Нет отзывов за период</p>';
  $('#probCats').innerHTML = s.categories.map((c) => {
    const mx = Math.max(1, ...c.by_month);
    return `<div class="card prob-card ${prob.cat === c.key ? 'active' : ''}" data-cat="${c.key}">
      <div class="head"><b>${c.count}</b><span>${esc(c.title)}</span><span class="muted">${c.share}% плохих</span></div>
      <div class="spark" title="По месяцам">${c.by_month.map((n) => `<i style="height:${(n / mx) * 100}%"></i>`).join('')}</div>
      ${c.examples.slice(0, 2).map((e) => `<div class="ex">${e.rating ?? '—'}★ · ${new Date(e.created_at).toLocaleDateString('ru-RU')} — «${esc(e.quote)}»</div>`).join('')}
      <div class="muted">Последняя жалоба: ${c.last_at ? new Date(c.last_at).toLocaleDateString('ru-RU') : '—'}</div>
    </div>`;
  }).join('') || '<p class="muted">Плохих отзывов за период нет 🎉</p>';
  renderProblemList();
}

function renderProblemList() {
  const s = prob.data;
  const cat = s.categories.find((c) => c.key === prob.cat);
  const list = prob.cat ? s.reviews.filter((r) => r.problems.includes(prob.cat)) : s.reviews;
  const titles = Object.fromEntries(s.categories.map((c) => [c.key, c.title]));
  $('#probListTitle').textContent = cat ? `${cat.title}: ${list.length}` : `Все плохие отзывы: ${list.length}`;
  $('#probReset').classList.toggle('hidden', !prob.cat);
  $('#probList').innerHTML = list.slice(0, 300).map((r) => `<div class="bad-review">
      <div><b>${r.source === 'google' ? 'Google' : 'Яндекс'}</b> · ${stars(r.rating)} · ${esc(r.author || 'Аноним')} · <span class="muted">${r.date_approx ? '≈ ' : ''}${new Date(r.created_at).toLocaleDateString('ru-RU')}${state.clientId ? '' : ` · ${esc(r.client_name)}`}</span></div>
      <div>${esc(r.text) || '<span class="muted">(без текста)</span>'}</div>
      <div class="ptags">${r.problems.map((k) => `<span class="ptag">${esc(titles[k] || k)}</span>`).join('')}${r.owner_reply ? '<span class="ptag ok">есть ответ на площадке</span>' : r.status === 'approved' ? '<span class="ptag ok">ответ одобрен</span>' : '<span class="ptag">без ответа</span>'}</div>
      ${r.owner_reply ? `<div class="muted">Ответ: ${esc(r.owner_reply)}</div>` : ''}
    </div>`).join('') || '<p class="muted">Нет отзывов</p>';
}

$('#probCats').addEventListener('click', (e) => {
  const card = e.target.closest('.prob-card');
  if (!card) return;
  prob.cat = prob.cat === card.dataset.cat ? '' : card.dataset.cat;
  $$('.prob-card').forEach((x) => x.classList.toggle('active', x.dataset.cat === prob.cat));
  renderProblemList();
});
$('#probReset').onclick = () => { prob.cat = ''; $$('.prob-card').forEach((x) => x.classList.remove('active')); renderProblemList(); };
$$('#probPeriod button').forEach((b) => b.addEventListener('click', () => {
  prob.months = Number(b.dataset.months);
  $$('#probPeriod button').forEach((x) => x.classList.toggle('active', x === b));
  renderProblems().catch(fail);
}));

// ---------- Очередь отзывов ----------
$$('#statusSeg button').forEach((b) => b.addEventListener('click', () => {
  state.status = b.dataset.status;
  $$('#statusSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderReviews().catch(fail);
}));
$('#sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; renderReviews().catch(fail); });

function fillReview(el, r) {
  el.className = `review ${r.sentiment || ''}`;
  el.dataset.id = r.id;
  const src = $('.src', el); src.className = `src ${r.source}`; src.textContent = r.source === 'google' ? 'Google' : 'Яндекс';
  $('.stars', el).textContent = stars(r.rating);
  $('.author', el).textContent = r.author || 'Аноним';
  $('.date', el).textContent = r.date_approx ? `≈ ${new Date(r.created_at).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}` : fmtDate(r.created_at);
  $('.client', el).textContent = state.clientId ? '' : r.client_name;
  const st = $('.status', el); st.className = `pill status ${r.display_status}`; st.textContent = STATUS[r.display_status];
  $('.text', el).textContent = r.text || '(без текста)';
  const reply = $('.owner-reply', el);
  reply.classList.toggle('hidden', !r.owner_reply);
  reply.textContent = r.owner_reply ? `Ответ организации на площадке: ${r.owner_reply}` : '';
  $('.tags', el).innerHTML = [
    r.sentiment && `<span class="tag">${SENT[r.sentiment]}</span>`,
    r.topic && `<span class="tag">${esc(r.topic)}</span>`,
    r.urgency && `<span class="tag ${r.urgency}">${URG[r.urgency]}</span>`,
    r.ai_engine && `<span class="tag">${r.ai_engine === 'claude' ? 'черновик: Claude' : 'черновик: шаблон'}</span>`,
  ].filter(Boolean).join('');
  $('.draft', el).value = r.draft_reply || '';
  $('.draft', el).placeholder = r.owner_reply && !r.draft_reply ? 'Организация уже ответила на площадке. Нажмите «Перегенерировать», если нужен свой вариант.' : 'Черновик ещё готовится…';
  $('.approve', el).disabled = !r.draft_reply || r.status === 'approved';
}

async function renderReviews() {
  const q = new URLSearchParams();
  if (state.clientId) q.set('client_id', state.clientId);
  if (state.status) q.set('status', state.status);
  if (state.source) q.set('source', state.source);
  const list = await api(`/api/reviews?${q}`);
  const box = $('#reviewList');
  box.innerHTML = list.length ? '' : '<p class="muted">Отзывов нет</p>';
  for (const r of list.slice(0, 200)) {
    const el = $('#reviewTpl').content.firstElementChild.cloneNode(true);
    fillReview(el, r);
    box.append(el);
  }
}

$('#reviewList').addEventListener('click', async (e) => {
  const el = e.target.closest('.review');
  if (!el || e.target.tagName !== 'BUTTON') return;
  const id = el.dataset.id, btn = e.target;
  try {
    btn.disabled = true;
    if (btn.classList.contains('copy')) {
      await navigator.clipboard.writeText($('.draft', el).value);
      btn.textContent = 'Скопировано';
      return;
    }
    let r;
    if (btn.classList.contains('approve')) {
      if ($('.draft', el).value.trim()) await api(`/api/reviews/${id}`, { method: 'PATCH', body: { draft_reply: $('.draft', el).value } });
      r = await api(`/api/reviews/${id}/approve`, { method: 'POST' });
    } else if (btn.classList.contains('save')) {
      r = await api(`/api/reviews/${id}`, { method: 'PATCH', body: { draft_reply: $('.draft', el).value } });
    } else if (btn.classList.contains('regen')) {
      btn.textContent = 'Генерирую…';
      r = await api(`/api/reviews/${id}/regenerate`, { method: 'POST', body: { hint: $('.hint', el).value } });
      btn.textContent = 'Перегенерировать';
    }
    if (r) fillReview(el, r);
  } catch (err) { fail(err); } finally { btn.disabled = false; }
});

// ---------- Статистика ----------
$('#statsMonth').value = ymd(new Date()).slice(0, 7);
$('#statsMonth').addEventListener('change', () => renderStats().catch(fail));

function bars(items) {
  const max = Math.max(1, ...items.map(([, n]) => n));
  return items.map(([l, n, color]) => `<div class="hbar"><span>${esc(l)}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%;${color ? `background:${color}` : ''}"></div></div><b>${n}</b></div>`).join('');
}

async function renderStats() {
  const [y, m] = $('#statsMonth').value.split('-').map(Number);
  const q = new URLSearchParams({ from: new Date(y, m - 1, 1).toISOString(), to: new Date(y, m, 1).toISOString() });
  if (state.clientId) q.set('client_id', state.clientId);
  const s = await api(`/api/stats?${q}`);
  $('#statsBody').innerHTML = `
    <div class="month-kpis">
      <div class="kpi"><b>${s.total}</b><span>отзывов</span></div>
      <div class="kpi"><b>${s.avg_rating ?? '—'}</b><span>средняя оценка</span></div>
      <div class="kpi"><b>${s.sources.google.total} / ${s.sources.yandex.total}</b><span>Google / Яндекс</span></div>
      <div class="kpi"><b>${s.status.approved}</b><span>одобрено ответов</span></div>
      <div class="kpi"><b>${s.status.overdue}</b><span>просрочено по SLA</span></div>
    </div>
    <div class="stats-grid">
      <div class="card"><h3>Тональность</h3>${bars([['позитив', s.sentiment.positive, 'var(--pos)'], ['нейтрально', s.sentiment.neutral, 'var(--neu)'], ['негатив', s.sentiment.negative, 'var(--neg)']])}</div>
      <div class="card"><h3>Оценки</h3>${bars([5, 4, 3, 2, 1].map((n) => [`${n} ★`, s.ratings[n - 1], '#f59f00']))}</div>
      <div class="card"><h3>Площадки</h3>${bars([['Google', s.sources.google.total, '#4285f4'], ['Яндекс', s.sources.yandex.total, '#fc3f1d']])}
        <p class="muted">Средняя оценка: Google ${s.sources.google.avg_rating ?? '—'}, Яндекс ${s.sources.yandex.avg_rating ?? '—'}</p></div>
      <div class="card"><h3>Темы</h3>${s.topics.length ? bars(s.topics) : '<p class="muted">Нет данных</p>'}</div>
    </div>`;
}

$('#summaryBtn').addEventListener('click', async () => {
  const clientId = state.clientId || state.clients[0]?.id;
  if (!clientId) return alert('Добавьте клиента');
  const btn = $('#summaryBtn'), box = $('#summaryBox');
  btn.disabled = true; btn.textContent = 'Формирую…';
  try {
    const s = await api('/api/summary', { method: 'POST', body: { client_id: clientId, month: $('#statsMonth').value } });
    box.classList.remove('hidden');
    box.innerHTML = `<h3>Сводка: ${esc(s.client)}, ${esc(s.month)}</h3><p>${esc(s.text)}</p>`;
  } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = 'Сформировать сводку за месяц'; }
});

// ---------- Клиенты ----------
async function renderClients() {
  await loadClients();
  $('#clientList').innerHTML = state.clients.length
    ? state.clients.map((c) => `<div class="card client-item" data-id="${c.id}"><b>${esc(c.name)}</b><div class="muted">${esc(c.services || 'услуги не указаны')}</div>
      <div class="muted">${c.yandex_org_url ? 'Яндекс Карты указаны' : 'Яндекс не указан'} · ${c.google_maps_url || c.google_location ? 'Google указан' : 'Google не указан'}</div></div>`).join('')
    : '<p class="muted">Клиентов пока нет</p>';
}
function fillClientForm(c = {}) {
  const f = $('#clientForm');
  for (const k of ['id', 'name', 'services', 'tone', 'contacts', 'stop_words', 'google_location', 'yandex_org_url', 'google_maps_url']) f[k].value = c[k] ?? '';
  $('#clientFormTitle').textContent = c.id ? 'Редактирование клиента' : 'Новый клиент';
  $('#clientDelete').classList.toggle('hidden', !c.id);
}
$('#clientList').addEventListener('click', (e) => {
  const item = e.target.closest('.client-item');
  if (item) fillClientForm(state.clients.find((c) => c.id == item.dataset.id));
});
$('#clientReset').onclick = () => fillClientForm();
$('#clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const c = await api(body.id ? `/api/clients/${body.id}` : '/api/clients', { method: body.id ? 'PUT' : 'POST', body });
    fillClientForm(c);
    await renderClients();
  } catch (err) { fail(err); }
});
$('#clientDelete').onclick = async () => {
  const id = $('#clientForm').id.value;
  if (!id || !confirm('Удалить клиента вместе с его отзывами?')) return;
  await api(`/api/clients/${id}`, { method: 'DELETE' }).catch(fail);
  fillClientForm();
  renderClients().catch(fail);
};

// ---------- Источники ----------
async function renderImport() { await Promise.all([loadClients(), loadStatus()]); }

$('#googleSync').addEventListener('click', async () => {
  const out = $('#googleResult');
  out.classList.remove('hidden'); out.textContent = 'Загружаю…';
  try {
    const rep = await api('/api/sync/google', { method: 'POST', body: { client_id: state.clientId || undefined } });
    out.textContent = rep.length ? rep.map((r) => (r.error ? `${r.client}: ошибка — ${r.error}` : `${r.client}: получено ${r.fetched}, новых ${r.added}`)).join('\n') : 'Нет клиентов с указанным Google location';
  } catch (e) { out.textContent = e.message; }
});

$('#mapsSync').addEventListener('click', async () => {
  const out = $('#mapsResult'), btn = $('#mapsSync');
  out.classList.remove('hidden'); out.textContent = 'Загружаю отзывы с карт, это может занять пару минут…';
  btn.disabled = true;
  try {
    out.textContent = mapsReport(await api('/api/sync/maps', { method: 'POST', body: { client_id: state.clientId || undefined } })) + '\nЧерновики ответов готовятся в фоне.';
  } catch (e) { out.textContent = e.message; } finally { loadStatus().catch(() => {}); }
});

$('#csvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('#csvResult');
  out.classList.remove('hidden'); out.textContent = 'Загружаю…';
  try {
    const csv = await f.file.files[0].text();
    const r = await api('/api/import/csv', { method: 'POST', body: { client_id: f.client_id.value, source: f.source.value, csv } });
    out.textContent = `Добавлено: ${r.added}, уже были: ${r.skipped}${r.errors.length ? `\nОшибки:\n${r.errors.join('\n')}` : ''}\nЧерновики ответов готовятся в фоне.`;
  } catch (err) { out.textContent = err.message; }
});

$('#tgPreview').addEventListener('click', async () => {
  const out = $('#tgResult');
  out.classList.remove('hidden');
  try {
    // Превью без HTML-разметки Telegram
    const { text } = await api('/api/telegram/preview');
    out.textContent = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  } catch (e) { out.textContent = e.message; }
});
$('#tgSend').addEventListener('click', async () => {
  const out = $('#tgResult');
  out.classList.remove('hidden'); out.textContent = 'Отправляю…';
  try {
    const r = await api('/api/telegram/send', { method: 'POST' });
    out.textContent = `Отправлено администраторам: ${r.sent_to}`;
  } catch (e) { out.textContent = e.message; }
});

// ---------- Старт ----------
(async () => {
  await Promise.all([loadClients(), loadStatus()]);
  refresh();
  // Обновление статусов отзывов (ТЗ: не позднее 5 секунд)
  setInterval(() => { if (activeTab() === 'reviews' && !document.activeElement?.matches('textarea, input')) renderReviews().catch(() => {}); }, 5000);
})().catch(fail);
