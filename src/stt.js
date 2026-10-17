// Распознавание голосовых сообщений Telegram через Yandex SpeechKit (работает в России,
// принимает формат голосовых Telegram — OGG/Opus — без конвертации).
// .env: YANDEX_SPEECHKIT_API_KEY (API-ключ сервисного аккаунта с ролью ai.speechkit-stt.user),
// YANDEX_FOLDER_ID — нужен, только если ключ не сервисного аккаунта.
// Ограничение синхронного распознавания: до 30 секунд и 1 МБ на сообщение.
const KEY = process.env.YANDEX_SPEECHKIT_API_KEY || '';
const FOLDER = process.env.YANDEX_FOLDER_ID || '';

export const sttConfigured = () => Boolean(KEY);
export const STT_MAX_SECONDS = 30;

export async function transcribe(ogg) {
  if (!KEY) throw new Error('Распознавание голоса не настроено: укажите YANDEX_SPEECHKIT_API_KEY в .env');
  if (ogg.length > 1024 * 1024) throw new Error('Голосовое длиннее 1 МБ, запишите короче (до 30 секунд)');
  const q = new URLSearchParams({ lang: 'ru-RU', format: 'oggopus', topic: 'general' });
  if (FOLDER) q.set('folderId', FOLDER);
  const res = await fetch(`https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?${q}`, {
    method: 'POST',
    headers: { Authorization: `Api-Key ${KEY}` },
    body: ogg,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SpeechKit: ${data.error_message || res.status}`);
  return String(data.result || '').trim();
}
