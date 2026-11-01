'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');

const SAUC_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const RESOURCE_ID = process.env.DOUBAO_RESOURCE_ID || 'volc.seedasr.sauc.duration';

function apiKey() {
  return process.env.DOUBAO_API_KEY || '';
}

function buildFrame(msgType, flags, serialization, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf[0] = 0x11;
  buf[1] = ((msgType & 0x0f) << 4) | (flags & 0x0f);
  buf[2] = (serialization & 0x0f) << 4;
  buf[3] = 0x00;
  buf.writeUInt32BE(payload.length, 4);
  payload.copy(buf, 8);
  return buf;
}

function parseFrame(data) {
  if (data.length < 4) return { msgType: 0, error: '帧过短' };
  const msgType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const compression = data[2] & 0x0f;
  let pos = 4;
  if (msgType === 0x0f) {
    const code = data.readUInt32BE(pos); pos += 4;
    let msg = '';
    if (pos + 4 <= data.length) {
      const len = data.readUInt32BE(pos); pos += 4;
      msg = data.slice(pos, Math.min(pos + len, data.length)).toString('utf8');
    }
    return { msgType, flags, errorCode: code, errorMessage: msg };
  }
  let sequence;
  if ((flags & 0b0011) === 0b0001 || (flags & 0b0011) === 0b0011) {
    sequence = data.readInt32BE(pos); pos += 4;
  }
  if (pos + 4 > data.length) return { msgType, flags, sequence, payload: Buffer.alloc(0) };
  const len = data.readUInt32BE(pos); pos += 4;
  let payload = data.slice(pos, Math.min(pos + len, data.length));
  if (compression === 1 && payload.length) {
    try { payload = zlib.gunzipSync(payload); } catch { /* ignore */ }
  }
  return { msgType, flags, sequence, payload };
}

/** PCM 16k/16bit/mono -> 豆包流式识别文本 */
async function transcribePcm(pcm) {
  const key = apiKey();
  if (!key) {
    throw Object.assign(new Error('网关未配置 DOUBAO_API_KEY'), { status: 503, code: 'GATEWAY_NOT_CONFIGURED' });
  }
  const ws = new WebSocket(SAUC_URL, {
    headers: {
      'X-Api-Key': key,
      'X-Api-Resource-Id': RESOURCE_ID,
      'X-Api-Connect-Id': crypto.randomUUID(),
      'X-Api-Request-Id': crypto.randomUUID(),
      'X-Api-Sequence': '-1',
    },
    handshakeTimeout: 15000,
  });

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error('豆包识别超时')), 30000);
    function done(err, text) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(text);
    }
    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => done(Object.assign(new Error(`豆包连接被拒绝 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`), { status: 502, code: 'UPSTREAM_AUTH' })));
    });
    ws.on('error', (e) => done(Object.assign(new Error(`豆包连接失败: ${e.message}`), { status: 502, code: 'UPSTREAM_ERROR' })));
    ws.on('open', () => {
      const start = {
        user: { uid: 'clarify' },
        audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
        request: {
          model_name: 'bigmodel', enable_itn: true, enable_punc: true,
          show_utterances: true, result_type: 'full', enable_nonstream: false,
        },
      };
      ws.send(buildFrame(0b0001, 0b0000, 0b0001, Buffer.from(JSON.stringify(start))));

      const CHUNK = 6400;
      let offset = 0;
      let sentFinal = false;
      (async () => {
        while (offset < pcm.length) {
          const piece = pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length));
          const isLast = offset + piece.length >= pcm.length;
          ws.send(buildFrame(0b0010, isLast ? 0b0010 : 0b0000, 0b0000, piece));
          if (isLast) sentFinal = true;
          offset += piece.length;
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!sentFinal) ws.send(buildFrame(0b0010, 0b0010, 0b0000, Buffer.alloc(0)));
      })().catch((e) => done(e));
    });

    let finalText = '';
    ws.on('message', (data) => {
      try {
        const frame = parseFrame(Buffer.from(data));
        if (frame.msgType === 0x0f) {
          done(Object.assign(new Error(`豆包识别错误 [${frame.errorCode}] ${frame.errorMessage}`), { status: 502, code: 'UPSTREAM_ERROR' }));
          return;
        }
        if (frame.msgType === 0b1001 && frame.payload && frame.payload.length) {
          const obj = JSON.parse(frame.payload.toString('utf8'));
          if (obj?.result?.text) finalText = obj.result.text;
          const isFinal = (frame.flags & 0b0010) !== 0 || (frame.sequence !== undefined && frame.sequence < 0);
          if (isFinal) done(null, finalText);
        }
      } catch (e) {
        done(Object.assign(new Error(`豆包响应解析失败: ${e.message}`), { status: 502, code: 'UPSTREAM_BAD_JSON' }));
      }
    });
    ws.on('close', () => { if (!settled) done(null, finalText); });
  });

  return result;
}

module.exports = { transcribePcm };
