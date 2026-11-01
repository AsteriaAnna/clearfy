'use strict';

/**
 * 阿里云函数计算（FC）HTTP 入口。
 * 兼容 FC 3.x 函数 URL 事件 与 API 网关事件。
 */
const { handle } = require('./lib/app');

function coerceEvent(event) {
  let e = event;
  if (Buffer.isBuffer(e)) {
    try { e = JSON.parse(e.toString('utf8')); } catch { e = {}; }
  } else if (typeof e === 'string') {
    try { e = JSON.parse(e); } catch { e = {}; }
  }
  return e || {};
}

function normalize(event) {
  const e = coerceEvent(event);
  const reqContext = e.requestContext || {};
  const http = reqContext.http || {};
  const method = (e.httpMethod || http.method || 'GET').toUpperCase();
  let path = http.path || e.rawPath || e.path || '/';
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
      'content-disposition': 'inline',
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'inline',
    },
    body,
    isBase64Encoded: false,
  };
}

exports.handler = async (event) => {
  try {
    const req = normalize(event);
    const res = await handle(req);
    if (res.html) return htmlResponse(res.status, res.html);
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
