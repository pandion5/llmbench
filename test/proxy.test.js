'use strict';
// 프록시가 요청을 줄 세우고 기록을 남기는지 본다. llama-server 대신 가짜 서버를 띄운다.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const proxy = require('../src/proxy');

// 조각을 천천히 흘려보내는 가짜 llama-server.
function fakeUpstream(delayMs) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization || null, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = ['안녕', '하세', '요'];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= parts.length) {
          clearInterval(timer);
          res.write('data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":3}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: {"choices":[{"delta":{"content":"${parts[i]}"}}]}\n\n`);
        i += 1;
      }, delayMs);
    });
  });
  return { server, seen };
}

let PORT = 0;

function post(body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

(async () => {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llmbench-proxy-'));
  const up = fakeUpstream(20);
  await listen(up.server, 0);
  const upPort = up.server.address().port;

  // 8080은 다른 프로그램이 쓰고 있을 수 있다. 검사에서는 빈 포트를 쓴다.
  proxy.start({
    upstream: `http://127.0.0.1:${upPort}`,
    apiKey: 'testkey123',
    logDir,
    peers: [{ name: '박영범', address: '10.66.0.2' }],
    limit: 1,
    port: 0
  });
  await new Promise((r) => setTimeout(r, 200));
  const addr = proxy.address();
  assert.ok(addr, `프록시가 안 떴다: ${proxy.status().error}`);
  PORT = addr.port;

  // 1) 답이 그대로 흘러나온다.
  const r1 = await post({ model: 'qwen38', messages: [{ role: 'user', content: '인사해줘' }], stream: true });
  assert.strictEqual(r1.status, 200, String(r1.status));
  assert.ok(r1.body.includes('안녕'), r1.body.slice(0, 200));
  assert.ok(r1.body.includes('[DONE]'), '끝 표시가 없다');

  // 2) 업스트림에는 우리가 가진 키가 붙는다.
  assert.strictEqual(up.seen[0].auth, 'Bearer testkey123', String(up.seen[0].auth));

  // 3) 기록이 남는다. 질문과 답이 다 들어간다.
  await new Promise((r) => setTimeout(r, 100));
  const day = new Date().toISOString().slice(0, 10);
  const rows = await proxy.readLog(day);
  assert.strictEqual(rows.length, 1, `기록 ${rows.length}줄`);
  assert.strictEqual(rows[0].prompt, '인사해줘', rows[0].prompt);
  assert.strictEqual(rows[0].answer, '안녕하세요', rows[0].answer);
  assert.strictEqual(rows[0].model, 'qwen38');
  assert.strictEqual(rows[0].tokens, 3);
  assert.strictEqual(rows[0].who, '이 PC', rows[0].who);

  // 4) 슬롯이 하나면 둘째는 줄을 선다.
  const p1 = post({ model: 'qwen38', messages: [{ role: 'user', content: '첫째' }], stream: true });
  await new Promise((r) => setTimeout(r, 30));
  const p2 = post({ model: 'qwen38', messages: [{ role: 'user', content: '둘째' }], stream: true });
  await new Promise((r) => setTimeout(r, 30));
  const mid = proxy.status();
  assert.strictEqual(mid.running.length, 1, `도는 중 ${mid.running.length}`);
  assert.strictEqual(mid.waiting.length, 1, `기다리는 중 ${mid.waiting.length}`);
  assert.strictEqual(mid.waiting[0].who, '이 PC');
  await Promise.all([p1, p2]);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(proxy.status().running.length, 0, '다 끝나야 한다');

  // 5) 키가 틀리면 막는다. 바깥에서 온 것처럼 보이게 할 수는 없으니
  //    로컬은 그냥 지나가는 것만 확인한다.
  const r2 = await post({ model: 'qwen38', messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer wrong' });
  assert.strictEqual(r2.status, 200, '로컬은 키 없이도 지나간다');

  // 6) 상태 조회는 키를 요구한다.
  const st = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/llmbench/status', headers: { Authorization: 'Bearer wrong' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.strictEqual(st, 401, `상태 조회 ${st}`);

  // 7) 질문 뽑기가 마지막 사용자 발화를 고른다.
  const pick = proxy._internal.promptOf({
    messages: [
      { role: 'user', content: '앞선 질문' },
      { role: 'assistant', content: '앞선 답' },
      { role: 'user', content: '이번 질문' }
    ]
  });
  assert.strictEqual(pick, '이번 질문', pick);

  // 8) 주소에서 IPv4를 꺼낸다.
  assert.strictEqual(proxy._internal.cleanAddress('::ffff:10.66.0.2'), '10.66.0.2');
  assert.strictEqual(proxy._internal.cleanAddress('::1'), '127.0.0.1');

  proxy.stop();
  up.server.close();
  await fsp.rm(logDir, { recursive: true, force: true });
  console.log('통과');
})().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
