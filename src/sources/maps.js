// Парсер публичных отзывов с Яндекс Карт и Google Карт через настоящий Chrome (или Edge).
// Работает в обычном окне браузера, вынесенном за пределы экрана: фоновый (headless) режим
// обе площадки распознают и отдают пустую страницу или урезанную карточку.
// Профиль браузера хранится в data/browser-profile. Google без входа в аккаунт показывает
// только ~5 отзывов, поэтому один раз выполните `npm run google-login` и войдите в Google.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const PROFILE_DIR = resolve(process.env.BROWSER_PROFILE || 'data/browser-profile');
const MAX = Number(process.env.PARSER_MAX_REVIEWS || 200);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
export const browserPath = () => CANDIDATES.find((p) => p && existsSync(p)) || null;

export async function openBrowser({ visible = process.env.PARSER_SHOW_BROWSER === '1' } = {}) {
  const executablePath = browserPath();
  if (!executablePath) throw new Error('Не найден Chrome или Edge. Установите Chrome или укажите путь в CHROME_PATH в .env');
  mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath,
    headless: false,
    locale: 'ru-RU',
    viewport: { width: 1400, height: 900 },
    args: visible ? ['--window-size=1400,1000'] : ['--window-position=-2400,-2400', '--window-size=1400,900'],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Прокрутка ленты отзывов, пока не наберётся max, не кончатся отзывы
// или не пойдут подряд уже известные (лента отсортирована по новизне).
async function scrollFeed(page, itemSel, { max, known, readIds }) {
  let prev = 0, still = 0;
  for (;;) {
    const ids = await readIds(page);
    const tail = ids.slice(-10);
    if (ids.length >= max) break;
    if (known.size && tail.length >= 10 && tail.every((id) => id && known.has(id))) break;
    still = ids.length === prev ? still + 1 : 0;
    if (still >= 3) break;
    prev = ids.length;
    await page.evaluate((sel) => {
      const items = document.querySelectorAll(sel);
      let el = items[items.length - 1];
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, itemSel);
    await sleep(1500);
  }
}

async function checkCaptcha(page, site) {
  if (/showcaptcha|captcha|sorry\/index/.test(page.url())) {
    throw new Error(`${site} показал проверку «я не робот». Запустите парсер с PARSER_SHOW_BROWSER=1 в .env, пройдите проверку в открывшемся окне и повторите загрузку`);
  }
}

// ---------- Яндекс Карты ----------
export function yandexOrg(url) {
  const m = String(url).match(/yandex\.[a-z]+\/maps\/(?:\d+\/[^/]+\/)?org\/([^/?#]+)\/(\d+)/);
  if (!m) throw new Error('Ссылка на Яндекс Карты должна быть вида https://yandex.ru/maps/org/название/1234567890/');
  return { orgId: m[2], reviewsUrl: `https://yandex.ru/maps/org/${m[1]}/${m[2]}/reviews/` };
}

export async function scrapeYandex(ctx, url, { max = MAX, known = new Set() } = {}) {
  const { orgId, reviewsUrl } = yandexOrg(url);
  const page = await ctx.newPage();
  try {
    await page.goto(reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await checkCaptcha(page, 'Яндекс');
    await page.waitForSelector('.business-review-view', { timeout: 30_000 }).catch(async () => {
      await checkCaptcha(page, 'Яндекс');
      throw new Error('Яндекс не показал отзывы: проверьте ссылку на организацию');
    });
    const title = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    // Сортировка «По новизне»
    await sleep(1000);
    await page.click('.rating-ranking-view');
    await page.locator('.rating-ranking-view__popup-line', { hasText: 'По новизне' }).click({ timeout: 10_000 });
    await sleep(2500);

    // У отзыва Яндекса нет публичного id: дата публикации до миллисекунд + автор уникальны.
    const extId = (date, author) => 'y-' + createHash('sha1').update(`${orgId}|${date}|${author.trim()}`).digest('hex').slice(0, 24);
    const readIds = async (p) => (await p.$$eval('.business-review-view', (els) => els.map((e) => [
      e.querySelector('meta[itemprop=datePublished]')?.content || '',
      e.querySelector('[itemprop=author] [itemprop=name]')?.textContent || '',
    ]))).map(([d, a]) => extId(d, a));
    await scrollFeed(page, '.business-review-view', { max, known, readIds });

    // Раскрыть «ещё» и ответы организации
    await page.$$eval('.business-review-view__expand, .business-review-comment-expandable-view__expand', (bs) => bs.forEach((b) => b.click()));
    await sleep(800);
    const raw = await page.$$eval('.business-review-view', (els) => els.map((e) => ({
      date: e.querySelector('meta[itemprop=datePublished]')?.content || '',
      author: e.querySelector('[itemprop=author] [itemprop=name]')?.textContent?.trim() || '',
      rating: Number(e.querySelector('meta[itemprop=ratingValue]')?.content) || null,
      text: (e.querySelector('.spoiler-view__text-container') || e.querySelector('.business-review-view__body'))?.innerText?.trim() || '',
      reply: e.querySelector('.business-review-comment-content__bubble, .business-review-view__comment-content')?.innerText?.trim()
        || (e.querySelector('.business-review-view__business-comment') ? '(есть ответ организации)' : ''),
    })));
    const reviews = raw.filter((r) => r.date).slice(0, max).map((r) => ({
      source: 'yandex',
      external_id: extId(r.date, r.author),
      author: r.author,
      rating: r.rating ? Math.round(r.rating) : null,
      text: r.text.slice(0, 3000),
      created_at: new Date(r.date).toISOString(),
      owner_reply: r.reply.slice(0, 3000),
    }));
    return { title, reviews };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- Google Карты ----------
// Google показывает только относительную дату («3 месяца назад»), переводим её в примерную.
const UNITS = [
  [/минут/, 60e3], [/час/, 36e5], [/(день|дня|дней)/, 864e5], [/недел/, 7 * 864e5], [/месяц/, 30 * 864e5], [/(год|года|лет)/, 365 * 864e5],
];
export function parseRelativeRu(s, now = Date.now()) {
  s = String(s || '').toLowerCase().replace(/^.*?:\s*/, '').trim();
  if (/только что|сейчас/.test(s)) return new Date(now).toISOString();
  if (/вчера/.test(s)) return new Date(now - 864e5).toISOString();
  const n = Number((s.match(/\d+/) || [1])[0]);
  const unit = UNITS.find(([re]) => re.test(s));
  return unit ? new Date(now - n * unit[1]).toISOString() : null;
}

export function checkGoogleUrl(url) {
  if (!/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/.test(String(url))) {
    throw new Error('Ссылка на Google Карты должна быть вида https://www.google.com/maps/place/… или https://maps.app.goo.gl/…');
  }
  return url;
}

export async function scrapeGoogle(ctx, url, { max = MAX, known = new Set() } = {}) {
  const page = await ctx.newPage();
  try {
    const u = new URL(checkGoogleUrl(url));
    if (u.hostname.includes('google.')) u.searchParams.set('hl', 'ru');
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await checkCaptcha(page, 'Google');
    if (/consent\.google/.test(page.url())) {
      throw new Error('Google просит принять условия. Выполните npm run google-login, примите или отклоните условия в окне и повторите');
    }
    await page.waitForSelector('button[role=tab]', { timeout: 30_000 });
    const title = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    const tab = page.locator('button[role=tab]', { hasText: 'Отзывы' });
    if (!(await tab.count())) throw new Error('Google не показал вкладку «Отзывы» для этого места');
    await tab.first().click();
    await page.waitForSelector('div.jftiEf[data-review-id]', { timeout: 30_000 });
    await sleep(1000);
    // Сортировка «Сначала новые»
    const sort = page.locator('button', { hasText: 'Самые релевантные' }).first();
    if (await sort.count()) {
      await sort.click();
      await page.locator('[role=menuitemradio]', { hasText: 'Сначала новые' }).click({ timeout: 10_000 });
      await sleep(2500);
    }
    const readIds = (p) => p.$$eval('div.jftiEf[data-review-id]', (els) => els.map((e) => e.getAttribute('data-review-id')));
    await scrollFeed(page, 'div.jftiEf[data-review-id]', { max, known, readIds });
    await page.$$eval('div.jftiEf button.w8nwRe', (bs) => bs.forEach((b) => b.click()));
    await sleep(800);
    const raw = await page.$$eval('div.jftiEf[data-review-id]', (els) => els.map((e) => ({
      id: e.getAttribute('data-review-id'),
      author: e.getAttribute('aria-label') || '',
      rating: Number((e.querySelector('[role=img][aria-label]')?.getAttribute('aria-label') || '').match(/\d/)?.[0]) || null,
      when: e.querySelector('.rsqaWe')?.innerText || '',
      text: e.querySelector('.wiI7pd')?.innerText?.trim() || '',
      reply: e.querySelector('.CDe7pd .wiI7pd')?.innerText?.trim() || (e.querySelector('.CDe7pd') ? '(есть ответ владельца)' : ''),
    })));
    const now = Date.now();
    const reviews = raw.slice(0, max).map((r) => ({
      source: 'google',
      external_id: r.id,
      author: r.author,
      rating: r.rating,
      text: r.text.slice(0, 3000),
      created_at: parseRelativeRu(r.when, now) || new Date(now).toISOString(),
      date_approx: true,
      owner_reply: r.reply.slice(0, 3000),
    }));
    const signedIn = await page.locator('a[href*="SignOutOptions"], a[aria-label*="Аккаунт Google"]').count().catch(() => 0);
    return { title, reviews, limited: !signedIn && reviews.length <= 5 };
  } finally {
    await page.close().catch(() => {});
  }
}
