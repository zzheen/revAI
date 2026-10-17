// Google: официальный Google Business Profile API (v4, reviews).
// Отдаёт все отзывы только по карточкам, где ваш Google-аккаунт владелец или менеджер.
// Нужны: проект в Google Cloud с одобренным доступом к Business Profile API,
// OAuth-клиент и refresh token с областью https://www.googleapis.com/auth/business.manage.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://mybusiness.googleapis.com/v4';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export const googleConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

async function accessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// location: строка вида "accounts/123/locations/456"
export async function fetchGoogleReviews(location) {
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(location)) {
    throw new Error('Укажите в карточке клиента Google location в формате accounts/…/locations/…');
  }
  const token = await accessToken();
  const out = [];
  let pageToken = '';
  do {
    const url = `${API}/${location}/reviews?pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google reviews: ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const r of data.reviews || []) {
      out.push({
        source: 'google',
        external_id: r.reviewId,
        author: r.reviewer?.displayName || '',
        rating: STARS[r.starRating] ?? null,
        text: r.comment || '',
        created_at: r.createTime,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}
