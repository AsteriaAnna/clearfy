'use strict';

/**
 * 生成激活码（在本地运行，不要提交 ACTIVATION_SECRET）。
 * 用法：
 *   $env:ACTIVATION_SECRET="至少32位随机串"
 *   node tools/gen-activation.js --parse 300 --voice 3600 --days 30 --plan plus
 */
const { createCode } = require('../lib/activation');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

if (!process.env.ACTIVATION_SECRET) {
  console.error('请先设置 ACTIVATION_SECRET（与网关环境变量一致）');
  process.exit(1);
}

const parseQuota = Number(arg('parse', 300));
const voiceSeconds = Number(arg('voice', 3600));
const days = Number(arg('days', 30));
const plan = arg('plan', 'plus');
const id = arg('id', undefined);

const { code, payload } = createCode({ id, parseQuota, voiceSeconds, days, plan });
console.log('激活码：');
console.log(code);
console.log('\n对应额度：');
console.log(JSON.stringify(payload, null, 2));
