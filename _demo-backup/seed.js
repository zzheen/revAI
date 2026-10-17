// Демо-данные: клиент, ~70 отзывов за два месяца и несколько встреч.
// Запуск: npm run seed (повторный запуск ничего не дублирует).
import { db, insertReview } from './db.js';
import { heuristic } from './ai.js';

let client = db.prepare("SELECT * FROM clients WHERE name = 'Стоматология Улыбка (демо)'").get();
if (!client) {
  const r = db.prepare(`INSERT INTO clients (name, services, tone, contacts, stop_words) VALUES (?,?,?,?,?)`).run(
    'Стоматология Улыбка (демо)',
    'лечение и профилактика зубов, гигиена, имплантация, детская стоматология',
    'тёплый, заботливый, на «вы», без канцелярита',
    '+7 900 000-00-00, info@ulybka.example',
    'скидка, бесплатно, гарантируем, дешево',
  );
  client = { id: Number(r.lastInsertRowid) };
}

const samples = [
  [5, 'Очень внимательный врач, всё объяснили, лечение прошло без боли. Спасибо!'],
  [5, 'Чисто, уютно, администратор вежливая. Записалась на гигиену снова.'],
  [4, 'Хорошая клиника, но пришлось подождать минут 20 после времени записи.'],
  [5, 'Ребёнок не боялся, врач нашла подход. Рекомендую детское отделение.'],
  [2, 'Долго ждала в коридоре, администратор была груба по телефону.'],
  [1, 'Ужасный сервис, перенесли запись два раза и не предупредили.'],
  [3, 'Лечение нормальное, но цены выше, чем ожидала.'],
  [4, 'Удобная онлайн-запись, парковка рядом. Качество хорошее.'],
  [5, 'Поставили имплант, всё прошло отлично, наблюдают после операции.'],
  [3, 'Нормально, ничего особенного.'],
  [2, 'Пломба выпала через неделю, жду, что переделают.'],
  [5, 'Лучшая гигиена в районе, зубы как новые!'],
];
const authors = ['Анна К.', 'Игорь П.', 'Мария С.', 'Олег В.', 'Екатерина Л.', 'Дмитрий Н.', 'Ольга Р.', 'Сергей Т.', 'Наталья Б.', 'Алексей М.'];

let added = 0;
const now = Date.now();
for (let i = 0; i < 70; i++) {
  const [rating, text] = samples[(i * 7) % samples.length];
  const created = new Date(now - ((i * 0.87) % 60) * 864e5 - (i % 9) * 36e5);
  const id = insertReview({
    client_id: client.id,
    source: i % 3 === 0 ? 'yandex' : i % 3 === 1 ? 'google' : (i % 2 ? 'yandex' : 'google'),
    external_id: `demo-${i}`,
    author: authors[i % authors.length],
    rating,
    text,
    created_at: created.toISOString(),
  });
  if (id) added++;
}
// Старые отзывы считаем обработанными (простым анализом без ИИ), чтобы календарь не был сплошь «просрочен».
const cl = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
const old = db.prepare("SELECT * FROM reviews WHERE client_id = ? AND external_id LIKE 'demo-%' AND created_at < ? AND status = 'new'")
  .all(client.id, new Date(now - 5 * 864e5).toISOString());
for (const r of old) {
  const o = heuristic(r, cl);
  db.prepare(`UPDATE reviews SET sentiment=?, topic=?, urgency=?, draft_reply=?, ai_engine='demo', status='approved', approved_at=datetime('now') WHERE id=?`)
    .run(o.sentiment, o.topic, o.urgency, o.draft_reply, r.id);
}

const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
if (!db.prepare('SELECT 1 FROM meetings WHERE client_id = ?').get(client.id)) {
  for (const [days, h, title] of [[1, 11, 'Созвон с клиентом: разбор негативных отзывов'], [3, 15, 'Встреча: отчёт за месяц'], [-6, 10, 'Планёрка по ответам'], [9, 12, 'Встреча с новым администратором клиники']]) {
    const d = new Date(now + days * 864e5); d.setHours(h, 0, 0, 0);
    db.prepare('INSERT INTO meetings (client_id, title, starts_at, duration_min) VALUES (?,?,?,60)').run(client.id, title, local(d));
  }
}
console.log(`Готово: добавлено отзывов ${added}. Новые отзывы обработает ИИ после запуска сервера (npm start).`);
