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
      if (body.includes('"stream":false')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{\n  "choices": [{"message": {"content": "정상"}}],\n  "usage": {"completion_tokens": 2, "prompt_tokens": 5}\n}\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = ['안녕', '하세', '요'];
      let i = 0;
      // 첫 글자를 바이트 중간에서 갈라 보낸다. 프록시가 디코더 없이 이으면 깨진다.
      const split = Buffer.from('data: {"choices":[{"delta":{"content":"한"}}]}\n\n', 'utf8');
      res.write(split.subarray(0, 40));
      const timer = setInterval(() => {
        if (i === 0 && split.length > 40) { res.write(split.subarray(40)); }
        if (i >= parts.length) {
          clearInterval(timer);
          res.write('data: {"choices":[],"usage":{"completion_tokens":3,"prompt_tokens":11},"timings":{"prompt_n":11,"prompt_ms":220,"predicted_n":3,"predicted_ms":60}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        // 진행률 조각. 우리가 붙이라고 한 것이라 하네스에는 안 가야 한다.
        if (i === 0) res.write('data: {"choices":[],"prompt_progress":{"total":11,"cache":0,"processed":6,"time_ms":100}}\n\n');
        // 첫 조각은 도구 호출로 시작한다. 하네스가 이렇게 보낸다.
        if (i === 0) res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n');
        if (i === 0) res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"a.js\\"}"}}]}}]}\n\n');
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
  // 예열 파일은 logDir 옆 warm 폴더에 남으니 임시 폴더 안에 한 단계 더 둔다.
  const logDir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'llmbench-proxy-')), 'chat');
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
    port: 0,
    blockModels: ['qwen36'],
    serverInfo: async () => ({ status: { state: 'ready', models: [] }, logs: ['한 줄'] }),
    control: {
      startServer: async (from) => ({ ok: true, by: from.who }),
      stopServer: async () => ({ ok: true }),
      benchRun: async (from, body) => ({ ok: true, got: body })
    },
    benchInfo: async () => ({ busy: false, last: { mode: 'ncmoe' } })
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
  assert.ok(!r1.body.includes('prompt_progress'), '진행률 조각이 하네스로 새 나갔다');

  // 2) 업스트림에는 우리가 가진 키가 붙는다.
  assert.strictEqual(up.seen[0].auth, 'Bearer testkey123', String(up.seen[0].auth));

  // 3) 기록이 남는다. 질문과 답이 다 들어간다.
  await new Promise((r) => setTimeout(r, 100));
  const dn = new Date();
  const day = `${dn.getFullYear()}-${String(dn.getMonth() + 1).padStart(2, '0')}-${String(dn.getDate()).padStart(2, '0')}`;
  const rows = await proxy.readLog(day);
  assert.strictEqual(rows.length, 1, `기록 ${rows.length}줄`);
  assert.strictEqual(rows[0].prompt, '인사해줘', rows[0].prompt);
  assert.strictEqual(rows[0].answer, '한안녕하세요', rows[0].answer);
  assert.ok(r1.body.includes('"한"'), '글자가 조각 경계에서 깨졌다');
  assert.strictEqual(rows[0].model, 'qwen38');
  assert.strictEqual(rows[0].tokens, 3);
  assert.strictEqual(rows[0].promptTokens, 11, String(rows[0].promptTokens));
  assert.strictEqual(rows[0].promptMs, 220, String(rows[0].promptMs));
  assert.strictEqual(rows[0].genMs, 60, String(rows[0].genMs));
  assert.strictEqual(rows[0].tools.length, 1, JSON.stringify(rows[0].tools));
  assert.strictEqual(rows[0].tools[0].name, 'read_file');
  assert.strictEqual(rows[0].tools[0].args, '{"path":"a.js"}', rows[0].tools[0].args);
  // 스트리밍 요청에는 프록시가 usage 옵션을 붙여 보낸다.
  assert.ok(up.seen[0].body.includes('include_usage'), up.seen[0].body);
  assert.ok(up.seen[0].body.includes('"return_progress":true'), up.seen[0].body);
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

  // 6-2) 서버 상태와 로그를 키 있는 쪽에만 준다.
  const srv = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/llmbench/server', headers: { Authorization: 'Bearer testkey123' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
    });
  });
  assert.strictEqual(srv.status, 200);
  assert.strictEqual(srv.body.status.state, 'ready');
  assert.deepStrictEqual(srv.body.logs, ['한 줄']);

  // 6-3) 켜기는 POST만 받고, 누가 시켰는지 넘긴다. 없는 동작은 501.
  const call = (method, p, body) => new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { Authorization: 'Bearer testkey123', 'Content-Type': 'application/json' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    rq.end(body || undefined);
  });
  const g = await call('GET', '/llmbench/server/start');
  assert.strictEqual(g.status, 405, `GET으로 켜기 ${g.status}`);
  const st2 = await call('POST', '/llmbench/server/start');
  assert.strictEqual(st2.status, 200);
  assert.strictEqual(st2.body.by, '이 PC');
  // 긴 시스템 프롬프트는 예열용으로 모델별 파일에 남는다. 짧은 것은 남기지 않는다.
  await post({ model: 'qwen38', messages: [{ role: 'system', content: 'x'.repeat(5000) }, { role: 'user', content: '예열용' }], tools: [{ type: 'function', function: { name: 'read_file' } }], stream: true });
  await post({ model: 'qwen36', messages: [{ role: 'system', content: '짧다' }, { role: 'user', content: '무시' }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  let warm = await proxy.warmPrompts();
  // 시스템 프롬프트가 다른 하네스는 파일이 따로 남는다.
  await post({ model: 'qwen38', messages: [{ role: 'system', content: 'y'.repeat(5000) }, { role: 'user', content: '다른 하네스' }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  warm = await proxy.warmPrompts();
  assert.strictEqual(warm.length, 2, `예열 파일 ${warm.length}개`);
  assert.strictEqual(warm[0].messages[0].content[0], 'y', '최근 것이 먼저여야 한다');
  warm = warm.filter((w) => w.messages[0].content[0] === 'x');
  assert.strictEqual(warm.length, 1, `예열 파일 ${warm.length}개`);
  assert.strictEqual(warm[0].model, 'qwen38');
  assert.strictEqual(warm[0].messages.length, 2);
  assert.strictEqual(warm[0].messages[0].content.length, 5000);
  assert.strictEqual(warm[0].tools[0].function.name, 'read_file');
  // 사람 질문은 남기지 않는다.
  assert.strictEqual(warm[0].messages[1].content, '.');
  const warmDirT = path.join(logDir, '..', 'warm');
  for (const f of await fsp.readdir(warmDirT)) {
    const raw = await fsp.readFile(path.join(warmDirT, f), 'utf8');
    assert.ok(!raw.includes('예열용') && !raw.includes('다른 하네스'), `${f}에 질문이 남았다`);
  }

  // 깨진 본문으로는 벤치가 시작되지 않는다. 배열 같은 객체 아닌 본문도 같다.
  const badBody = await call('POST', '/llmbench/bench/run', '{');
  assert.strictEqual(badBody.status, 400, `깨진 본문 ${badBody.status}`);
  const arrBody = await call('POST', '/llmbench/bench/run', '[]');
  assert.strictEqual(arrBody.status, 400, `배열 본문 ${arrBody.status}`);
  // 스트리밍이 아닌 응답은 그대로 전달되고 기록도 남는다.
  const ns = await post({ model: 'qwen38', messages: [{ role: 'user', content: '비스트리밍' }], stream: false });
  assert.strictEqual(ns.status, 200);
  assert.ok(ns.body.includes('"정상"'), ns.body.slice(0, 120));
  await new Promise((r) => setTimeout(r, 100));
  const nsRow = (await proxy.readLog(day)).find((r) => r.prompt === '비스트리밍');
  assert.ok(nsRow, '비스트리밍 기록이 없다');
  assert.strictEqual(nsRow.answer, '정상', nsRow.answer);
  assert.strictEqual(nsRow.tokens, 2, String(nsRow.tokens));
  // 잘못된 날짜로 폴더 밖 파일을 읽지 못한다.
  assert.deepStrictEqual(await proxy.readLog('/../secret'), []);
  // 막아 둔 모델은 400이다.
  const blocked = await post({ model: 'qwen36', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(blocked.status, 400, `막은 모델 ${blocked.status}`);

  const na = await call('POST', '/llmbench/update/apply');
  assert.strictEqual(na.status, 501, `없는 동작 ${na.status}`);
  // 누가 시켰는지 남는다. 켜기 한 번이 기록돼 있어야 한다.
  const evs = proxy.status().events;
  assert.strictEqual(evs.length, 1, `기록 ${evs.length}건`);
  assert.strictEqual(evs[0].who, '이 PC');
  assert.strictEqual(evs[0].action, '서버 켜기');
  assert.strictEqual(evs[0].ok, true);
  await new Promise((r) => setTimeout(r, 100));
  const ctl = await fsp.readFile(path.join(logDir, 'control.jsonl'), 'utf8');
  assert.ok(ctl.includes('서버 켜기'), ctl);

  // 예열 파일 목록과 비우기. 비운 뒤 같은 첫 턴이 오면 다시 남는다.
  const wl = await call('GET', '/llmbench/warm');
  assert.strictEqual(wl.body.length, 2, JSON.stringify(wl.body));
  assert.strictEqual(wl.body[0].system[0], 'y', '최근 것이 먼저여야 한다');
  assert.strictEqual(wl.body[1].tools, 1);
  const wc = await call('POST', '/llmbench/warm/clear');
  assert.strictEqual(wc.body.removed, 2, JSON.stringify(wc.body));
  assert.strictEqual((await proxy.warmPrompts()).length, 0);
  assert.strictEqual(proxy.status().events[0].action, '예열 파일 비우기');
  await post({ model: 'qwen38', messages: [{ role: 'system', content: 'x'.repeat(5000) }, { role: 'user', content: '예열용' }], tools: [{ type: 'function', function: { name: 'read_file' } }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual((await proxy.warmPrompts()).length, 1, '비운 뒤 다시 남아야 한다');
  // 같은 하네스의 다른 첫 질문은 내용이 같으니 파일을 다시 쓰지 않는다.
  const at0 = (await proxy.warmPrompts())[0].at;
  await post({ model: 'qwen38', messages: [{ role: 'system', content: 'x'.repeat(5000) }, { role: 'user', content: '다른 질문' }], tools: [{ type: 'function', function: { name: 'read_file' } }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual((await proxy.warmPrompts())[0].at, at0, '같은 내용인데 다시 썼다');
  // 예전 형식 파일에 질문이 들어 있어도 예열에는 "."로 나간다.
  await fsp.writeFile(path.join(warmDirT, 'qwen38-old.json'), JSON.stringify({ model: 'qwen38', at: 'old', messages: [{ role: 'system', content: 'z'.repeat(5000) }, { role: 'user', content: '옛 질문' }] }), 'utf8');
  const old = (await proxy.warmPrompts()).find((w) => w.at === 'old');
  assert.strictEqual(old.messages[1].content, '.', old.messages[1].content);
  // OpenClaude 첫 턴은 질문 앞 안내문을 따로 남긴다. 질문과 맨 끝 snip_id 블록은 남기지 않는다.
  const lead = '<available-deferred-tools>\nRead\n</available-deferred-tools>\n<system-reminder>\n오늘 날짜\n</system-reminder>\n\n\n\n';
  await post({ model: 'qwen38', messages: [{ role: 'system', content: 'o'.repeat(5000) }, { role: 'user', content: lead + '안내문 뒤 질문\n<system-reminder>snip_id=abc123; system-generated</system-reminder>' }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  const oc = (await proxy.warmPrompts()).find((w) => w.messages[0].content[0] === 'o');
  assert.strictEqual(oc.lead, lead, JSON.stringify(oc.lead));
  assert.strictEqual(oc.messages[1].content, '.');
  assert.strictEqual((await proxy.warmPrompts()).find((w) => w.messages[0].content[0] === 'x').lead, undefined, '안내문 없는 첫 턴에 안내문이 남았다');
  assert.strictEqual((await call('GET', '/llmbench/warm')).body.find((w) => w.system[0] === 'o').lead, lead.length);
  // 질문만 있거나 안내 블록 뒤가 비어 있으면 안내문이 없다.
  assert.strictEqual(proxy._internal.userLead('질문만\n<system-reminder>snip_id=x</system-reminder>'), '');
  assert.strictEqual(proxy._internal.userLead('<system-reminder>a</system-reminder>\n'), '');
  // 정밀 예열 본문은 처음 갈라지는 곳 뒤로 4토큰을 더 싣는다.
  assert.deepStrictEqual(proxy.leadWarmBody('qwen38', [1, 2, 3, 9, 8, 7, 6, 5], [1, 2, 3, 4, 8]).prompt, [1, 2, 3, 9, 8, 7, 6]);
  assert.strictEqual(proxy.leadWarmBody('qwen38', [1, 2, 3, 9], [1, 2, 3, 4]), null, '뒤에 붙일 토큰이 모자라다');
  assert.strictEqual(proxy.leadWarmBody('qwen38', [5, 6, 7, 8, 9], [1, 2]), null, '겹치는 앞부분이 없다');
  // 두 하네스의 날짜 형식을 모두 바꾼다.
  assert.strictEqual(proxy._internal.withDate("a Today's date: Wed Sep 23 2026 b Today's date is 2026-09-23. c", new Date(2026, 0, 5)),
    "a Today's date: Mon Jan 05 2026 b Today's date is 2026-01-05. c");
  // 날짜만 다른 첫 턴은 한 파일에 남고, 예열에는 오늘 날짜로 나간다.
  const sysDay = (d) => 'd'.repeat(5000) + `\n  Today's date: ${d}\n`;
  const leadDay = (d) => `<system-reminder>\nToday's date is ${d}.\n</system-reminder>\n\n`;
  await post({ model: 'qwen38', messages: [{ role: 'system', content: sysDay('Mon Sep 21 2026') }, { role: 'user', content: leadDay('2026-09-21') + '그제 질문' }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  await post({ model: 'qwen38', messages: [{ role: 'system', content: sysDay('Tue Sep 22 2026') }, { role: 'user', content: leadDay('2026-09-22') + '어제 질문' }], stream: true });
  await new Promise((r) => setTimeout(r, 100));
  const dated = (await proxy.warmPrompts()).filter((w) => w.messages[0].content[0] === 'd');
  assert.strictEqual(dated.length, 1, `날짜만 다른 첫 턴이 파일 ${dated.length}개로 남았다`);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  assert.strictEqual(dated[0].messages[0].content, sysDay(today.toDateString()));
  assert.strictEqual(dated[0].lead, leadDay(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`));

  // 6-4) 벤치 시작은 본문을 그대로 넘기고, 조회는 결과를 준다.
  const br = await new Promise((resolve) => {
    const data = JSON.stringify({ model: 'qwen36', mode: 'standard' });
    const rq = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/llmbench/bench/run',
      headers: { Authorization: 'Bearer testkey123', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve(JSON.parse(out)));
    });
    rq.write(data);
    rq.end();
  });
  assert.deepStrictEqual(br.got, { model: 'qwen36', mode: 'standard' }, JSON.stringify(br));
  const bi = await call('GET', '/llmbench/bench');
  assert.strictEqual(bi.body.last.mode, 'ncmoe');

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
