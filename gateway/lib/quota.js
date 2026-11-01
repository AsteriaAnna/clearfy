'use strict';

const { verifyCode } = require('./activation');

const FREE_PARSE_PER_DAY = Number(process.env.FREE_PARSE_PER_DAY || 5);
const FREE_VOICE_SECONDS_PER_DAY = Number(process.env.FREE_VOICE_SECONDS_PER_DAY || 30);
const TABLE = process.env.TABLESTORE_TABLE || 'clarify_quota';
// server：服务端扣额度（需要 Tablestore/Redis）；client：客户端计数（零存储、可被绕过，适合首版）
const QUOTA_MODE = (process.env.QUOTA_MODE || 'server').toLowerCase();

/** 仅无 Tablestore 配置时兜底：单实例内存，重启即丢；生产必须配 Tablestore。 */
const memory = new Map();
function useMemory() {
  return !(process.env.TABLESTORE_ENDPOINT && process.env.TABLESTORE_INSTANCE);
}

let client = null;
function getClient() {
  if (useMemory()) return null;
  if (client) return client;
  const TableStore = require('tablestore');
  client = new TableStore.Client({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || process.env.TABLESTORE_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || process.env.TABLESTORE_ACCESS_KEY_SECRET,
    endpoint: process.env.TABLESTORE_ENDPOINT,
    instancename: process.env.TABLESTORE_INSTANCE,
    maxRetries: 2,
  });
  return client;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.QUOTA_TIMEZONE || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function wrap(fn) {
  return new Promise((resolve, reject) => fn((err, data) => (err ? reject(err) : resolve(data))));
}

async function readRow(pk) {
  if (useMemory()) {
    return memory.get(pk) || { parse_used: 0, voice_sec: 0 };
  }
  const c = getClient();
  try {
    const data = await wrap((cb) => c.getRow({ tableName: TABLE, primaryKey: [{ pk }], maxVersions: 1 }, cb));
    const cols = (data && data.row && data.row.attributeColumns) || [];
    const rec = { parse_used: 0, voice_sec: 0 };
    for (const item of cols) {
      const [name, ...vals] = Object.entries(item)[0] || [];
      if (!name) continue;
      const v = Number(vals[0]);
      if (name === 'parse_used') rec.parse_used = v;
      if (name === 'voice_sec') rec.voice_sec = v;
    }
    return rec;
  } catch (e) {
    if (e && (e.code === 'OTSObjectNotExist' || e.status === 404)) return { parse_used: 0, voice_sec: 0 };
    throw e;
  }
}

async function writeRow(pk, rec) {
  if (useMemory()) {
    memory.set(pk, rec);
    return;
  }
  const c = getClient();
  const TableStore = require('tablestore');
  await wrap((cb) => c.putRow({
    tableName: TABLE,
    condition: new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null),
    primaryKey: [{ pk }],
    attributeColumns: [{ parse_used: rec.parse_used }, { voice_sec: rec.voice_sec }],
  }, cb));
}

function limitInfo(rec, limit, kind) {
  if (kind === 'parse') {
    return { used: rec.parse_used, limit, left: Math.max(0, limit - rec.parse_used) };
  }
  return { used: rec.voice_sec, limit, left: Math.max(0, limit - rec.voice_sec) };
}

/**
 * 扣减额度。带激活码时只扣激活码额度；没有激活码时扣每日免费额度。
 * 返回最新额度信息。
 */
async function consumeQuota({ deviceId, activationCode, ip, parse = 0, voiceSec = 0 }) {
  if (QUOTA_MODE === 'client') {
    let code = null;
    if (activationCode) {
      const payload = verifyCode(activationCode);
      code = { plan: payload.plan, expiresAt: payload.expiresAt, parseQuota: payload.parseQuota, voiceSeconds: payload.voiceSeconds };
    }
    return {
      mode: 'client',
      freeParse: { limit: FREE_PARSE_PER_DAY, left: null },
      freeVoice: { limit: FREE_VOICE_SECONDS_PER_DAY, left: null },
      code,
      memoryOnly: true,
    };
  }
  const day = todayKey();
  const freePk = `free:${deviceId || ip || 'anon'}:${day}`;
  const free = await readRow(freePk);

  if (activationCode) {
    const payload = verifyCode(activationCode);
    const codePk = `code:${payload.id}`;
    const used = await readRow(codePk);
    if (parse > 0 && used.parse_used + parse > payload.parseQuota) {
      const err = new Error('激活码的解析次数已用完');
      err.status = 429;
      err.code = 'CODE_PARSE_EXHAUSTED';
      throw err;
    }
    if (voiceSec > 0 && used.voice_sec + voiceSec > payload.voiceSeconds) {
      const err = new Error('激活码的语音秒数已用完');
      err.status = 429;
      err.code = 'CODE_VOICE_EXHAUSTED';
      throw err;
    }
    used.parse_used += parse;
    used.voice_sec += voiceSec;
    await writeRow(codePk, used);
    return {
      freeParse: limitInfo(free, FREE_PARSE_PER_DAY, 'parse'),
      freeVoice: limitInfo(free, FREE_VOICE_SECONDS_PER_DAY, 'voice'),
      code: {
        plan: payload.plan,
        expiresAt: payload.expiresAt,
        parseLeft: Math.max(0, payload.parseQuota - used.parse_used),
        voiceLeft: Math.max(0, payload.voiceSeconds - used.voice_sec),
      },
      memoryOnly: useMemory(),
    };
  }

  if (parse > 0 && free.parse_used >= FREE_PARSE_PER_DAY) {
    const err = new Error(`今日免费解析额度已用完（${FREE_PARSE_PER_DAY} 次），可以明天再来或使用激活码`);
    err.status = 429;
    err.code = 'FREE_PARSE_EXHAUSTED';
    throw err;
  }
  if (voiceSec > 0 && free.voice_sec + voiceSec > FREE_VOICE_SECONDS_PER_DAY) {
    const err = new Error(`今日免费语音额度已用完（${Math.round(FREE_VOICE_SECONDS_PER_DAY / 60)} 分钟），可以明天再来或使用激活码`);
    err.status = 429;
    err.code = 'FREE_VOICE_EXHAUSTED';
    throw err;
  }
  if (parse > 0) free.parse_used += parse;
  if (voiceSec > 0) free.voice_sec += voiceSec;
  await writeRow(freePk, free);

  return {
    freeParse: limitInfo(free, FREE_PARSE_PER_DAY, 'parse'),
    freeVoice: limitInfo(free, FREE_VOICE_SECONDS_PER_DAY, 'voice'),
    code: null,
    memoryOnly: useMemory(),
  };
}

async function quotaInfo({ deviceId, activationCode, ip }) {
  if (QUOTA_MODE === 'client') {
    let code = null;
    if (activationCode) {
      try {
        const payload = verifyCode(activationCode);
        code = { plan: payload.plan, expiresAt: payload.expiresAt, parseQuota: payload.parseQuota, voiceSeconds: payload.voiceSeconds };
      } catch {
        code = null;
      }
    }
    return {
      mode: 'client',
      freeParse: { limit: FREE_PARSE_PER_DAY, left: null },
      freeVoice: { limit: FREE_VOICE_SECONDS_PER_DAY, left: null },
      code,
    };
  }
  const day = todayKey();
  const freePk = `free:${deviceId || ip || 'anon'}:${day}`;
  const free = await readRow(freePk);
  let codeInfo = null;
  if (activationCode) {
    try {
      const payload = verifyCode(activationCode);
      const used = await readRow(`code:${payload.id}`);
      codeInfo = {
        plan: payload.plan,
        expiresAt: payload.expiresAt,
        parseLeft: Math.max(0, payload.parseQuota - used.parse_used),
        voiceLeft: Math.max(0, payload.voiceSeconds - used.voice_sec),
      };
    } catch {
      codeInfo = null;
    }
  }
  return {
    day,
    freeParse: limitInfo(free, FREE_PARSE_PER_DAY, 'parse'),
    freeVoice: limitInfo(free, FREE_VOICE_SECONDS_PER_DAY, 'voice'),
    code: codeInfo,
  };
}

module.exports = { consumeQuota, quotaInfo, FREE_PARSE_PER_DAY, FREE_VOICE_SECONDS_PER_DAY, todayKey, QUOTA_MODE };
