'use strict';

/** 本地联调：node dev-server.js（默认 8787）。生产用阿里云函数计算。 */
const http = require('http');
const { handle } = require('./lib/app');

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const result = await handle({
        method: req.method.toUpperCase(),
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        query: Object.fromEntries(url.searchParams.entries()),
      });
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.code || 'INTERNAL_ERROR', message: e.message }));
    }
  });
});

server.listen(port, () => {
  console.log(`Clarify gateway dev server: http://localhost:${port}`);
  console.log(`health: http://localhost:${port}/v1/health`);
});
