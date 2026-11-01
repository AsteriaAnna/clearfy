'use strict';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT = [
  '你是 Clarify 待办解析器。只输出严格 JSON，不要解释。',
  '输出格式：{"tasks":[{"title":"动作短语","time_type":"date|datetime|range|none","date":"YYYY-MM-DD 或 null","start":"HH:MM 或 null","end":"HH:MM 或 null","repeat":"day|week|month 或 null","repeat_weekdays":[1-7] 或 null,"count_target":整数或null,"count_period":"day|week 或 null"}]}。',
  '规则：只提取用户明确说出的时间/重复/计数；没说就不填(null)，绝不猜测；按动作拆成多条；标题是动作不是原话。',
].join('');

function apiKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

async function parseText({ text, nowLocal }) {
  const key = apiKey();
  if (!key) {
    const err = new Error('网关未配置 DEEPSEEK_API_KEY');
    err.status = 503;
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }
  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `输入：${text}\n当前时间：${nowLocal}` },
    ],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    max_tokens: 800,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw Object.assign(new Error(`DeepSeek HTTP ${resp.status} ${detail.slice(0, 200)}`), { status: 502, code: 'UPSTREAM_ERROR' });
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw Object.assign(new Error('DeepSeek 返回的 JSON 不合法'), { status: 502, code: 'UPSTREAM_BAD_JSON' });
    }
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error('DeepSeek 请求超时'), { status: 504, code: 'UPSTREAM_TIMEOUT' });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseText };
