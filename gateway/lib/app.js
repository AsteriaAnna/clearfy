'use strict';

const { parseText } = require('./deepseek');
const { transcribePcm } = require('./doubao');
const { consumeQuota, quotaInfo } = require('./quota');

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

  if (method === 'GET' && (p === '/v1/health' || p === '/health')) {
    return {
      status: 200,
      body: {
        ok: true,
        service: 'clarify-gateway',
        deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        doubaoConfigured: Boolean(process.env.DOUBAO_API_KEY),
        tablestoreConfigured: Boolean(process.env.TABLESTORE_ENDPOINT && process.env.TABLESTORE_INSTANCE),
        freeParsePerDay: Number(process.env.FREE_PARSE_PER_DAY || 20),
        freeVoiceSecondsPerDay: Number(process.env.FREE_VOICE_SECONDS_PER_DAY || 300),
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
