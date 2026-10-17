// Один раз: войти в Google в профиле браузера парсера, чтобы Google Карты показывали все отзывы.
// Запуск: npm run google-login. Откроется окно Chrome; войдите в аккаунт и закройте окно.
import { openBrowser, PROFILE_DIR } from './sources/maps.js';

const ctx = await openBrowser({ visible: true });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://accounts.google.com/ServiceLogin?hl=ru&continue=https://www.google.com/maps?hl=ru');
console.log(`Окно браузера открыто. Войдите в Google и закройте окно. Профиль: ${PROFILE_DIR}`);
console.log('Пока окно открыто, сервер (npm start) не сможет запускать парсер.');
await new Promise((r) => ctx.on('close', r));
console.log('Готово, вход сохранён.');
