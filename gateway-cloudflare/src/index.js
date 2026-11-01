/**
 * Clarify 官方网关 — Cloudflare Workers 版
 * DeepSeek 解析 + 豆包流式 ASR + D1 额度/激活码。
 * 部署见 README.md；Key 只通过 wrangler secret 注入。
 */

// Workers 通过 fetch + Upgrade 头建立外连 WebSocket，URL 用 https（不是 wss）
const SAUC_URL = 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT = [
  '你是 Clarify 待办解析器。只输出严格 JSON，不要解释。',
  '输出格式：{"tasks":[{"title":"动作短语","time_type":"date|datetime|range|none","date":"YYYY-MM-DD 或 null","start":"HH:MM 或 null","end":"HH:MM 或 null","repeat":"day|week|month 或 null","repeat_weekdays":[1-7] 或 null,"count_target":整数或null,"count_period":"day|week 或 null"}]}。',
  '规则：只提取用户明确说出的时间/重复/计数；没说就不填(null)，绝不猜测；按动作拆成多条；标题是动作不是原话。',
].join('');

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function appError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function envNum(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function b64urlToBytes(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function verifyActivation(code, secret) {
  if (!secret || secret.length < 16) throw appError(503, 'GATEWAY_MISCONFIGURED', '网关未配置 ACTIVATION_SECRET');
  if (!code || typeof code !== 'string') throw appError(401, 'NO_CODE', '激活码为空');
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'CLR1') throw appError(403, 'BAD_CODE', '激活码格式不正确');
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[1]));
  if (!ok) throw appError(403, 'BAD_CODE', '激活码无效');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    throw appError(403, 'BAD_CODE', '激活码内容损坏');
  }
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) {
    throw appError(403, 'CODE_EXPIRED', '激活码已过期');
  }
  return payload;
}

function memoryStore() {
  if (!globalThis.__clarifyMemoryQuota) globalThis.__clarifyMemoryQuota = new Map();
  return globalThis.__clarifyMemoryQuota;
}

async function getRow(env, pk) {
  if (!env.DB) {
    const map = memoryStore();
    return map.get(pk) || { parse_used: 0, voice_sec: 0 };
  }
  const row = await env.DB.prepare('SELECT parse_used, voice_sec FROM quota WHERE pk = ?').bind(pk).first();
  return row || { parse_used: 0, voice_sec: 0 };
}

async function putRow(env, pk, rec) {
  if (!env.DB) {
    memoryStore().set(pk, rec);
    return;
  }
  await env.DB.prepare(
    'INSERT INTO quota (pk, parse_used, voice_sec, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(pk) DO UPDATE SET parse_used = excluded.parse_used, voice_sec = excluded.voice_sec, updated_at = excluded.updated_at',
  ).bind(pk, rec.parse_used, rec.voice_sec, Date.now()).run();
}

function limitInfo(used, limit, kind) {
  return kind === 'parse'
    ? { used, limit, left: Math.max(0, limit - used) }
    : { used, limit, left: Math.max(0, limit - used) };
}

async function consumeQuota(env, { deviceId, activationCode, ip, parse = 0, voiceSec = 0 }) {
  const freeParse = envNum(env, 'FREE_PARSE_PER_DAY', 20);
  const freeVoice = envNum(env, 'FREE_VOICE_SECONDS_PER_DAY', 300);
  const day = todayKey();
  const freePk = `free:${deviceId || ip || 'anon'}:${day}`;
  const free = await getRow(env, freePk);

  if (activationCode) {
    const payload = await verifyActivation(activationCode, env.ACTIVATION_SECRET);
    const codePk = `code:${payload.id}`;
    const used = await getRow(env, codePk);
    if (parse > 0 && used.parse_used + parse > payload.parseQuota) throw appError(429, 'CODE_PARSE_EXHAUSTED', '激活码的解析次数已用完');
    if (voiceSec > 0 && used.voice_sec + voiceSec > payload.voiceSeconds) throw appError(429, 'CODE_VOICE_EXHAUSTED', '激活码的语音秒数已用完');
    used.parse_used += parse;
    used.voice_sec += voiceSec;
    await putRow(env, codePk, used);
    return {
      freeParse: limitInfo(free.parse_used, freeParse, 'parse'),
      freeVoice: limitInfo(free.voice_sec, freeVoice, 'voice'),
      code: {
        plan: payload.plan,
        expiresAt: payload.expiresAt,
        parseLeft: Math.max(0, payload.parseQuota - used.parse_used),
        voiceLeft: Math.max(0, payload.voiceSeconds - used.voice_sec),
      },
      memoryOnly: !env.DB,
    };
  }

  if (parse > 0 && free.parse_used >= freeParse) throw appError(429, 'FREE_PARSE_EXHAUSTED', `今日免费解析额度已用完（${freeParse} 次），可以明天再来或使用激活码`);
  if (voiceSec > 0 && free.voice_sec + voiceSec > freeVoice) throw appError(429, 'FREE_VOICE_EXHAUSTED', `今日免费语音额度已用完（${Math.round(freeVoice / 60)} 分钟），可以明天再来或使用激活码`);
  if (parse > 0) free.parse_used += parse;
  if (voiceSec > 0) free.voice_sec += voiceSec;
  await putRow(env, freePk, free);
  return {
    freeParse: limitInfo(free.parse_used, freeParse, 'parse'),
    freeVoice: limitInfo(free.voice_sec, freeVoice, 'voice'),
    code: null,
    memoryOnly: !env.DB,
  };
}

async function quotaInfo(env, { deviceId, activationCode, ip }) {
  const freeParse = envNum(env, 'FREE_PARSE_PER_DAY', 20);
  const freeVoice = envNum(env, 'FREE_VOICE_SECONDS_PER_DAY', 300);
  const day = todayKey();
  const free = await getRow(env, `free:${deviceId || ip || 'anon'}:${day}`);
  let code = null;
  if (activationCode) {
    try {
      const payload = await verifyActivation(activationCode, env.ACTIVATION_SECRET);
      const used = await getRow(env, `code:${payload.id}`);
      code = {
        plan: payload.plan,
        expiresAt: payload.expiresAt,
        parseLeft: Math.max(0, payload.parseQuota - used.parse_used),
        voiceLeft: Math.max(0, payload.voiceSeconds - used.voice_sec),
      };
    } catch {
      code = null;
    }
  }
  return {
    day,
    freeParse: limitInfo(free.parse_used, freeParse, 'parse'),
    freeVoice: limitInfo(free.voice_sec, freeVoice, 'voice'),
    code,
  };
}

async function parseText(env, { text, nowLocal }) {
  if (!env.DEEPSEEK_API_KEY) throw appError(503, 'GATEWAY_NOT_CONFIGURED', '网关未配置 DEEPSEEK_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `输入：${text}\n当前时间：${nowLocal}` },
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        max_tokens: 800,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw appError(502, 'UPSTREAM_ERROR', `DeepSeek HTTP ${resp.status}`);
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw appError(502, 'UPSTREAM_BAD_JSON', 'DeepSeek 返回的 JSON 不合法'); }
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch (e) {
    if (e.name === 'AbortError') throw appError(504, 'UPSTREAM_TIMEOUT', 'DeepSeek 请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function buildFrame(msgType, flags, serialization, payload) {
  const p = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
  const buf = new Uint8Array(8 + p.length);
  buf[0] = 0x11;
  buf[1] = ((msgType & 0x0f) << 4) | (flags & 0x0f);
  buf[2] = (serialization & 0x0f) << 4;
  buf[3] = 0x00;
  new DataView(buf.buffer).setUint32(4, p.length);
  buf.set(p, 8);
  return buf;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseFrame(data) {
  if (data.length < 4) return { msgType: 0 };
  const msgType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const compression = data[2] & 0x0f;
  let pos = 4;
  if (msgType === 0x0f) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const code = data.length >= 8 ? dv.getUint32(4) : 0;
    let message = '';
    if (data.length >= 12) {
      const len = dv.getUint32(8);
      message = new TextDecoder().decode(data.slice(12, Math.min(12 + len, data.length)));
    }
    return { msgType, flags, errorCode: code, errorMessage: message };
  }
  let sequence;
  if ((flags & 0b0011) === 0b0001 || (flags & 0b0011) === 0b0011) {
    if (pos + 4 > data.length) return { msgType, flags };
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    sequence = dv.getInt32(pos);
    pos += 4;
  }
  if (pos + 4 > data.length) return { msgType, flags, sequence, payload: new Uint8Array(0) };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(pos);
  pos += 4;
  const payload = data.slice(pos, Math.min(pos + len, data.length));
  return { msgType, flags, sequence, payload, compression };
}

async function transcribePcm(env, pcm) {
  if (!env.DOUBAO_API_KEY) throw appError(503, 'GATEWAY_NOT_CONFIGURED', '网关未配置 DOUBAO_API_KEY');
  const resource = env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration';
  let resp;
  try {
    resp = await fetch(SAUC_URL, {
      headers: {
        Upgrade: 'websocket',
        'X-Api-Key': env.DOUBAO_API_KEY,
        'X-Api-Resource-Id': resource,
        'X-Api-Connect-Id': crypto.randomUUID(),
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Sequence': '-1',
      },
    });
  } catch (e) {
    throw appError(502, 'UPSTREAM_ERROR', `豆包连接失败: ${e.message}`);
  }
  const ws = resp.webSocket;
  if (!ws) throw appError(502, 'UPSTREAM_ERROR', `豆包连接被拒绝 HTTP ${resp.status}`);
  ws.accept();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let finalText = '';
    const timer = setTimeout(() => done(appError(504, 'UPSTREAM_TIMEOUT', '豆包识别超时')), 30000);
    function done(err, text) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(text);
    }
    ws.addEventListener('message', async (event) => {
      try {
        let data;
        if (event.data instanceof ArrayBuffer) data = new Uint8Array(event.data);
        else if (event.data instanceof Blob) data = new Uint8Array(await event.data.arrayBuffer());
        else return;
        const frame = parseFrame(data);
        if (frame.msgType === 0x0f) {
          done(appError(502, 'UPSTREAM_ERROR', `豆包识别错误 [${frame.errorCode}] ${frame.errorMessage}`));
          return;
        }
        if (frame.msgType === 0b1001 && frame.payload && frame.payload.length) {
          let payload = frame.payload;
          if (frame.compression === 1) payload = await gunzip(payload);
          const obj = JSON.parse(new TextDecoder().decode(payload));
          if (obj?.result?.text) finalText = obj.result.text;
          const isFinal = (frame.flags & 0b0010) !== 0 || (frame.sequence !== undefined && frame.sequence < 0);
          if (isFinal) done(null, finalText);
        }
      } catch (e) {
        done(appError(502, 'UPSTREAM_BAD_JSON', `豆包响应解析失败: ${e.message}`));
      }
    });
    ws.addEventListener('error', () => done(appError(502, 'UPSTREAM_ERROR', '豆包连接异常')));
    ws.addEventListener('close', () => { if (!settled) done(null, finalText); });

    const start = {
      user: { uid: 'clarify' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
      request: {
        model_name: 'bigmodel', enable_itn: true, enable_punc: true,
        show_utterances: true, result_type: 'full', enable_nonstream: false,
      },
    };
    ws.send(buildFrame(0b0001, 0b0000, 0b0001, JSON.stringify(start)));

    (async () => {
      const CHUNK = 6400;
      let offset = 0;
      let sentFinal = false;
      while (offset < pcm.length) {
        const piece = pcm.slice(offset, Math.min(offset + CHUNK, pcm.length));
        const isLast = offset + piece.length >= pcm.length;
        ws.send(buildFrame(0b0010, isLast ? 0b0010 : 0b0000, 0b0000, piece));
        if (isLast) sentFinal = true;
        offset += piece.length;
        await new Promise((r) => setTimeout(r, 15));
      }
      if (!sentFinal) ws.send(buildFrame(0b0010, 0b0010, 0b0000, new Uint8Array(0)));
    })().catch((e) => done(appError(502, 'UPSTREAM_ERROR', `发送音频失败: ${e.message}`)));
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (method === 'GET' && (path === '/v1/health' || path === '/health')) {
    return json(200, {
      ok: true,
      service: 'clarify-gateway',
      runtime: 'cloudflare-workers',
      deepseekConfigured: Boolean(env.DEEPSEEK_API_KEY),
      doubaoConfigured: Boolean(env.DOUBAO_API_KEY),
      d1Configured: Boolean(env.DB),
      freeParsePerDay: envNum(env, 'FREE_PARSE_PER_DAY', 20),
      freeVoiceSecondsPerDay: envNum(env, 'FREE_VOICE_SECONDS_PER_DAY', 300),
    });
  }

  if (method === 'GET' && (path === '/v1/quota' || path === '/quota')) {
    return json(200, {
      ok: true,
      quota: await quotaInfo(env, {
        deviceId: (url.searchParams.get('deviceId') || '').slice(0, 128),
        activationCode: (url.searchParams.get('code') || '').slice(0, 4096),
        ip,
      }),
    });
  }

  if (method === 'POST' && (path === '/v1/parse' || path === '/parse')) {
    const data = await request.json();
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, 500) : '';
    if (!text) throw appError(400, 'BAD_REQUEST', 'text 不能为空');
    const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim().slice(0, 128) : '';
    if (!deviceId) throw appError(400, 'BAD_REQUEST', 'deviceId 不能为空');
    const activationCode = typeof data.activationCode === 'string' ? data.activationCode.trim().slice(0, 4096) : '';
    const quota = await consumeQuota(env, { deviceId, activationCode, ip, parse: 1 });
    const tasks = await parseText(env, { text, nowLocal: typeof data.nowLocal === 'string' ? data.nowLocal.slice(0, 64) : new Date().toISOString() });
    return json(200, { ok: true, tasks, quota });
  }

  if (method === 'POST' && (path === '/v1/transcribe' || path === '/transcribe')) {
    const data = await request.json();
    const b64 = typeof data.pcmBase64 === 'string' ? data.pcmBase64 : '';
    if (!b64) throw appError(400, 'BAD_REQUEST', 'pcmBase64 不能为空');
    const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim().slice(0, 128) : '';
    if (!deviceId) throw appError(400, 'BAD_REQUEST', 'deviceId 不能为空');
    const activationCode = typeof data.activationCode === 'string' ? data.activationCode.trim().slice(0, 4096) : '';
    const pcm = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (!pcm.length) throw appError(400, 'BAD_REQUEST', '音频为空');
    const seconds = pcm.length / 32000;
    if (seconds > 60) throw appError(413, 'AUDIO_TOO_LONG', '单次语音不能超过 60 秒');
    const voiceSec = Math.max(1, Math.ceil(seconds));
    const quota = await consumeQuota(env, { deviceId, activationCode, ip, voiceSec });
    const text = await transcribePcm(env, pcm);
    return json(200, { ok: true, text, quota });
  }

  throw appError(404, 'NOT_FOUND', `未知接口：${method} ${path}`);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      return json(e.status || 500, {
        ok: false,
        error: e.code || 'INTERNAL_ERROR',
        message: e.message || '网关内部错误',
      });
    }
  },
};
