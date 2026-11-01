'use strict';

const { parseText } = require('./deepseek');
const { transcribePcm } = require('./doubao');
const { consumeQuota, quotaInfo } = require('./quota');
const { QUOTA_MODE } = require('./quota');

function appError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

function clientIp(headers) {
  const xff = getHeader(headers, 'x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  return getHeader(headers, 'x-real-ip') || 'unknown';
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

async function handle({ method, path, headers, body, query }) {
  const p = (path || '/').replace(/\/+$/, '') || '/';
  const ip = clientIp(headers);
  const q = query || {};

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const ok = Boolean(process.env.DEEPSEEK_API_KEY && process.env.DOUBAO_API_KEY);
    return {
      status: 200,
      html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Clarify Gateway</title>
<style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#faf9f6;color:#333532;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border:1px solid #ece9e2;border-radius:18px;padding:32px 40px;box-shadow:0 18px 40px rgba(51,53,50,.08);max-width:520px}
h1{font-size:20px;margin:0 0 6px}p{color:#8a8880;font-size:13px;line-height:1.8}code{background:#f3f1ec;padding:2px 6px;border-radius:6px}
.badge{display:inline-block;background:${ok ? '#e7ede5' : '#f3e7ea'};color:${ok ? '#56705a' : '#8a5b66'};border-radius:20px;padding:4px 10px;font-size:12px;margin-bottom:16px}
a{color:#8a5b66}</style></head><body><div class="card">
<div class="badge">${ok ? '网关运行中' : '网关配置不完整'}</div>
<h1>Clarify 官方网关</h1>
<p>这是 AI 网关，不是网页应用。客户端会调用它完成语音识别和待办解析。</p>
<p>健康检查：<a href="/v1/health">/v1/health</a></p>
<p>免费额度：${Number(process.env.FREE_PARSE_PER_DAY || 5)} 次解析 + ${Number(process.env.FREE_VOICE_SECONDS_PER_DAY || 30)} 秒语音 / 天</p>
</div></body></html>`,
    };
  }

  if (method === 'GET' && (p === '/v1/health' || p === '/health')) {
    return {
      status: 200,
      body: {
        ok: true,
        service: 'clarify-gateway',
        deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        doubaoConfigured: Boolean(process.env.DOUBAO_API_KEY),
        tablestoreConfigured: Boolean(process.env.TABLESTORE_ENDPOINT && process.env.TABLESTORE_INSTANCE),
        quotaMode: QUOTA_MODE,
        freeParsePerDay: Number(process.env.FREE_PARSE_PER_DAY || 5),
        freeVoiceSecondsPerDay: Number(process.env.FREE_VOICE_SECONDS_PER_DAY || 30),
      },
    };
  }

  if (method === 'GET' && (p === '/v1/quota' || p === '/quota')) {
    return {
      status: 200,
      body: {
        ok: true,
        quota: await quotaInfo({
          deviceId: str(q.deviceId, 128),
          activationCode: str(q.code, 4096),
          ip,
        }),
      },
    };
  }

  if (method === 'POST' && (p === '/v1/parse' || p === '/parse')) {
    const data = JSON.parse(body || '{}');
    const text = str(data.text, 500);
    if (!text) throw appError(400, 'BAD_REQUEST', 'text 不能为空');
    const deviceId = str(data.deviceId, 128);
    if (!deviceId) throw appError(400, 'BAD_REQUEST', 'deviceId 不能为空');
    const activationCode = str(data.activationCode, 4096);
    const quota = await consumeQuota({ deviceId, activationCode, ip, parse: 1 });
    const tasks = await parseText({ text, nowLocal: str(data.nowLocal, 64) || new Date().toISOString() });
    return { status: 200, body: { ok: true, tasks, quota } };
  }

  if (method === 'POST' && (p === '/v1/transcribe' || p === '/transcribe')) {
    const data = JSON.parse(body || '{}');
    const b64 = str(data.pcmBase64, 8 * 1024 * 1024);
    if (!b64) throw appError(400, 'BAD_REQUEST', 'pcmBase64 不能为空');
    const deviceId = str(data.deviceId, 128);
    if (!deviceId) throw appError(400, 'BAD_REQUEST', 'deviceId 不能为空');
    const activationCode = str(data.activationCode, 4096);
    const pcm = Buffer.from(b64, 'base64');
    if (!pcm.length) throw appError(400, 'BAD_REQUEST', '音频为空');
    const seconds = pcm.length / 32000; // 16k * 16bit * mono
    if (seconds > 60) throw appError(413, 'AUDIO_TOO_LONG', '单次语音不能超过 60 秒');
    const voiceSec = Math.max(1, Math.ceil(seconds));
    const quota = await consumeQuota({ deviceId, activationCode, ip, voiceSec });
    const text = await transcribePcm(pcm);
    return { status: 200, body: { ok: true, text, quota } };
  }

  throw appError(404, 'NOT_FOUND', `未知接口：${method} ${p}`);
}

module.exports = { handle, clientIp, appError };
