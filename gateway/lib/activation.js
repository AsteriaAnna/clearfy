'use strict';

const crypto = require('crypto');

const VERSION = 'CLR1';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function secret() {
  const s = process.env.ACTIVATION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('ACTIVATION_SECRET 未配置或太短（至少 16 字符）');
  }
  return s;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/** 生成激活码：plan 里带解析次数、语音秒数、有效期。 */
function createCode({ id, parseQuota = 300, voiceSeconds = 3600, days = 30, plan = 'plus' }) {
  const now = Date.now();
  const payload = {
    v: 1,
    id: id || crypto.randomUUID().slice(0, 8).toUpperCase(),
    plan,
    parseQuota,
    voiceSeconds,
    issuedAt: now,
    expiresAt: now + days * 24 * 3600 * 1000,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return {
    code: `${VERSION}.${payloadB64}.${sign(payloadB64)}`,
    payload,
  };
}

/** 校验激活码；返回 payload 或抛出带 code 的错误。 */
function verifyCode(code) {
  if (!code || typeof code !== 'string') {
    const err = new Error('激活码为空');
    err.status = 401;
    err.code = 'NO_CODE';
    throw err;
  }
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    const err = new Error('激活码格式不正确');
    err.status = 403;
    err.code = 'BAD_CODE';
    throw err;
  }
  const payloadB64 = parts[1];
  const expected = sign(payloadB64);
  const actual = parts[2];
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('激活码无效');
    err.status = 403;
    err.code = 'BAD_CODE';
    throw err;
  }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) {
    const err = new Error('激活码已过期');
    err.status = 403;
    err.code = 'CODE_EXPIRED';
    throw err;
  }
  return payload;
}

module.exports = { createCode, verifyCode };
