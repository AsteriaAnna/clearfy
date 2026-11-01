'use strict';

/**
 * 阿里云函数计算（FC）HTTP 入口。
 * 兼容 FC 3.x 函数 URL 事件 与 API 网关事件。
 */
const { handle } = require('./lib/app');

function normalize(event) {
  const e = event || {};
  const reqContext = e.requestContext || {};
  const http = reqContext.http || {};
  const method = (e.httpMethod || http.method || 'GET').toUpperCase();
  let path = e.path || e.rawPath || http.path || '/';
  if (typeof path === 'string' && path.includes('?')) path = path.split('?')[0];
  const query = e.queryParameters || e.queryStringParameters || {};
  let body = e.body || '';
  if (e.isBase64Encoded && typeof body === 'string') {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  return { method, path, headers: e.headers || {}, body, query };
}

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

exports.handler = async (event) => {
  try {
    const req = normalize(event);
    const res = await handle(req);
    return response(res.status, res.body);
  } catch (e) {
    const status = e.status || 500;
    return response(status, {
      ok: false,
      error: e.code || 'INTERNAL_ERROR',
      message: e.message || '网关内部错误',
    });
  }
};

exports.normalize = normalize;
