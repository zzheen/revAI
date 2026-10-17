// Анализ отзыва и черновик ответа через Claude API.
// Без ANTHROPIC_API_KEY работает простой эвристический режим, чтобы прототип запускался сразу.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export const aiEnabled = () => Boolean(client);

const SCHEMA = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    topic: { type: 'string', description: 'Тема отзыва, 1-3 слова по-русски' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    draft_reply: { type: 'string' },
  },
  required: ['sentiment', 'topic', 'urgency', 'draft_reply'],
  additionalProperties: false,
};

const SYSTEM = `Ты помогаешь менеджеру агентства отвечать на отзывы клиентов в Google Картах и Яндекс Картах.
Определи тональность, тему и срочность отзыва и напиши черновик ответа от лица компании.
Правила для ответа:
- пиши по-русски, вежливо, в тоне из брифа клиента, 2-5 предложений;
- не обещай скидок, компенсаций и подарков, не придумывай факты, которых нет в брифе или отзыве;
- не используй стоп-слова из брифа;
- на негатив: извинись, признай проблему и предложи связаться по контактам из брифа;
- срочность high, если отзыв негативный или есть угроза репутации, жалоба на безопасность или здоровье.
Ответ публикует человек вручную после проверки.`;

function validate(o) {
  return o && ['positive', 'neutral', 'negative'].includes(o.sentiment)
    && typeof o.topic === 'string' && o.topic.trim()
    && ['low', 'medium', 'high'].includes(o.urgency)
    && typeof o.draft_reply === 'string' && o.draft_reply.trim();
}

function briefText(c) {
  return `Клиент: ${c.name}
Услуги: ${c.services || '—'}
Тон общения: ${c.tone || 'дружелюбный, профессиональный'}
Контакты для связи: ${c.contacts || '—'}
Стоп-слова: ${c.stop_words || '—'}`;
}

async function callClaude(review, cl, extra) {
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: `Бриф клиента:\n${briefText(cl)}\n\nОтзыв (${review.source === 'google' ? 'Google' : 'Яндекс'}, оценка ${review.rating ?? '—'} из 5, автор ${review.author || 'аноним'}):\n${review.text || '(без текста)'}${extra ? `\n\nПожелание менеджера к новому варианту: ${extra}` : ''}`,
    }],
  };
  let res;
  try {
    // Серверный fallback на случай отказа модели.
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    res = await client.messages.create(params);
  }
  if (res.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать на этот отзыв');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// Повтор с экспоненциальной задержкой (п. 4.2.2 ТЗ) и повторный запрос при несоответствии схеме (п. 4.1.2).
async function analyzeWithClaude(review, cl, extra) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await callClaude(review, cl, extra);
      if (validate(out)) return out;
      lastErr = new Error('Ответ ИИ не соответствует схеме');
    } catch (e) {
      lastErr = e;
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.NotFoundError) break;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

const NEG_WORDS = ['ужас', 'плох', 'хам', 'груб', 'долго', 'обман', 'не рекоменд', 'отврат', 'грязн', 'никогда'];

export function heuristic(review, cl) {
  const t = (review.text || '').toLowerCase();
  let sentiment = review.rating == null ? 'neutral' : review.rating >= 4 ? 'positive' : review.rating <= 2 ? 'negative' : 'neutral';
  if (review.rating == null && NEG_WORDS.some((w) => t.includes(w))) sentiment = 'negative';
  const topics = [['цен', 'цены'], ['персонал', 'персонал'], ['администратор', 'персонал'], ['ожидан', 'ожидание'], ['долго', 'ожидание'],
    ['запис', 'запись'], ['чист', 'чистота'], ['качеств', 'качество'], ['парков', 'парковка']];
  const topic = topics.find(([k]) => t.includes(k))?.[1] || 'общее впечатление';
  const name = review.author ? `${review.author.split(' ')[0]}, ` : '';
  const draft = {
    positive: `${name}спасибо за тёплый отзыв! Нам очень приятно, что вам понравилось. Будем рады видеть вас снова!`,
    neutral: `${name}спасибо, что поделились впечатлениями. Мы учтём ваши замечания, чтобы стать лучше. Будем рады видеть вас снова.`,
    negative: `${name}нам очень жаль, что визит оставил негативное впечатление. Пожалуйста, свяжитесь с нами${cl.contacts ? ` (${cl.contacts})` : ''}, чтобы мы разобрались в ситуации.`,
  }[sentiment];
  return { sentiment, topic, urgency: sentiment === 'negative' ? 'high' : sentiment === 'neutral' ? 'medium' : 'low', draft_reply: draft };
}

export async function analyzeReview(review, cl, extra) {
  if (client) return { ...(await analyzeWithClaude(review, cl, extra)), ai_engine: 'claude' };
  return { ...heuristic(review, cl), ai_engine: 'heuristic' };
}

export async function monthlySummary(cl, stats, samples) {
  if (!client) return null;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system: 'Ты аналитик агентства. Пиши по-русски, кратко и по делу, без markdown-заголовков.',
    messages: [{
      role: 'user',
      content: `Сделай месячную сводку по отзывам клиента «${cl.name}» на 5-8 предложений: общая картина, что хвалят, на что жалуются, что стоит сделать.\nМетрики: ${JSON.stringify(stats)}\nПримеры отзывов:\n${samples.map((s) => `- [${s.rating ?? '—'}] ${s.text}`).join('\n')}`,
    }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
