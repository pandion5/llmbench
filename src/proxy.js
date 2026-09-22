'use strict';
// llama-server 앞에 세우는 프록시. 누가 무엇을 물었고 무슨 답을 받았는지 남긴다.
// 요청을 줄 세워 한 번에 처리하는 수를 정하고, 지금 누가 쓰고 몇 명이 기다리는지 알려준다.
//
// 클라이언트와 하네스는 모두 이 프록시를 거친다. llama-server는 안쪽 포트에서만 듣는다.
// 누구인지는 터널 주소로 안다. WireGuard가 피어마다 주소를 고정해 주기 때문에
// 10.66.0.2에서 온 요청은 그 피어가 보낸 것이다.

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const PORT = 8080;
const HOST = '127.0.0.1';
const SHARE_HOST = '0.0.0.0';
// 기록을 남기는 경로. 나머지는 그대로 넘기기만 한다.
const CHAT_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/chat/completions', '/completions']);
const BODY_MAX = 8 * 1024 * 1024;

let server = null;
let opts = null;
let lastError = null;
let listener = null;
let seq = 0;

// 지금 돌고 있는 요청과 기다리는 요청.
const running = new Map();
const waiting = [];
// 최근에 끝난 것. 화면에서 바로 보여주려고 들고 있는다.
const recent = [];
const RECENT_MAX = 50;

function onEvent(cb) {
  listener = cb;
}

function emit() {
  if (listener) listener(status());
}

function status() {
  return {
    listening: !!(server && server.listening),
    error: lastError,
    host: opts ? opts.host : null,
    port: opts ? opts.port : PORT,
    upstream: opts ? opts.upstream : null,
    limit: opts ? opts.limit : 1,
    running: [...running.values()].map(view),
    waiting: waiting.map(view),
    recent: recent.map(view)
  };
}

function view(j) {
  return {
    id: j.id,
    who: j.who,
    address: j.address,
    model: j.model,
    at: j.at,
    startedAt: j.startedAt || null,
    endedAt: j.endedAt || null,
    waitMs: j.startedAt ? j.startedAt - j.at : Date.now() - j.at,
    runMs: j.startedAt ? (j.endedAt || Date.now()) - j.startedAt : 0,
    promptChars: j.prompt ? j.prompt.length : 0,
    answerChars: j.answer ? j.answer.length : 0,
    tokens: j.tokens || 0,
    promptTokens: j.promptTokens || 0,
    promptMs: j.promptMs || 0,
    genMs: j.genMs || 0,
    canceled: !!j.canceled,
    error: j.error || null
  };
}

// ---------- 누가 보냈나 ----------

function cleanAddress(raw) {
  const a = String(raw || '');
  // ::ffff:10.66.0.2 같은 형태로 들어온다
  const m = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];
  if (a === '::1') return '127.0.0.1';
  return a;
}

function whoIs(address) {
  if (address === '127.0.0.1') return '이 PC';
  const peers = (opts && opts.peers) || [];
  const hit = peers.find((p) => p.address === address);
  return hit ? hit.name : address;
}

// ---------- 기록 ----------

function logPath() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(opts.logDir, `chat-${day}.jsonl`);
}

async function writeLog(job) {
  if (!opts || !opts.logDir) return;
  const row = {
    at: new Date(job.at).toISOString(),
    who: job.who,
    address: job.address,
    model: job.model,
    waitMs: (job.startedAt || job.at) - job.at,
    runMs: (job.endedAt || Date.now()) - (job.startedAt || job.at),
    tokens: job.tokens || 0,
    promptTokens: job.promptTokens || 0,
    promptMs: job.promptMs || 0,
    genMs: job.genMs || 0,
    canceled: !!job.canceled,
    error: job.error || null,
    prompt: job.prompt || '',
    answer: job.answer || ''
  };
  try {
    await fsp.mkdir(opts.logDir, { recursive: true });
    await fsp.appendFile(logPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    // 기록을 못 남겨도 대화는 계속되게 둔다
  }
}

// 하루치 기록을 읽는다. 화면에서 지난 대화를 볼 때 쓴다.
async function readLog(day) {
  if (!opts || !opts.logDir) return [];
  const file = path.join(opts.logDir, `chat-${day}.jsonl`);
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      // 쓰다 만 줄은 건너뛴다
    }
  }
  return rows;
}

// 기록이 있는 날짜 목록.
async function logDays() {
  if (!opts || !opts.logDir) return [];
  try {
    const names = await fsp.readdir(opts.logDir);
    return names
      .filter((n) => /^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.slice(5, 15))
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

// ---------- 본문에서 질문과 답 꺼내기 ----------

function promptOf(body) {
  if (!body) return '';
  if (Array.isArray(body.messages)) {
    // 마지막 사용자 발화가 이번 질문이다. 앞의 것은 이미 지난 기록에 있다.
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === 'user') return textOf(m.content);
    }
    return textOf(body.messages[body.messages.length - 1] && body.messages[body.messages.length - 1].content);
  }
  return textOf(body.prompt);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

// 스트리밍 조각에서 답 글자를 모은다. 생각 과정은 답과 나눠 둔다.
function collectDelta(json, job) {
  const c = json.choices && json.choices[0];
  if (!c) return;
  const d = c.delta || c.message || {};
  if (typeof d.content === 'string') job.answer += d.content;
  if (typeof d.reasoning_content === 'string') job.reasoning += d.reasoning_content;
  if (typeof c.text === 'string') job.answer += c.text;
  if (json.usage && json.usage.completion_tokens) job.tokens = json.usage.completion_tokens;
  if (json.usage && json.usage.prompt_tokens) job.promptTokens = json.usage.prompt_tokens;
  // llama.cpp는 마지막 조각에 걸린 시간을 나눠서 준다. 프롬프트를 읽는 데 쓴 시간과
  // 답을 쓰는 데 쓴 시간이 갈려 있어서 어디가 느린지 바로 보인다.
  if (json.timings) {
    job.promptMs = Math.round(json.timings.prompt_ms || 0);
    job.genMs = Math.round(json.timings.predicted_ms || 0);
    if (json.timings.prompt_n) job.promptTokens = json.timings.prompt_n;
    if (json.timings.predicted_n) job.tokens = json.timings.predicted_n;
  }
}

// ---------- 줄 세우기 ----------

function pump() {
  const limit = (opts && opts.limit) || 1;
  while (running.size < limit && waiting.length) {
    const job = waiting.shift();
    if (job.aborted) continue;
    running.set(job.id, job);
    job.startedAt = Date.now();
    emit();
    job.go();
  }
}

function finish(job) {
  job.endedAt = Date.now();
  running.delete(job.id);
  recent.unshift(job);
  while (recent.length > RECENT_MAX) recent.pop();
  writeLog(job);
  emit();
  pump();
}

// ---------- 요청 처리 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new Error('본문이 너무 크다'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function forward(req, res, bodyBuf, job) {
  const url = new URL(opts.upstream);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

  const up = http.request(
    {
      host: url.hostname,
      port: url.port,
      method: req.method,
      path: req.url,
      headers
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      if (!job) {
        upRes.pipe(res);
        return;
      }
      // 흘러가는 조각을 그대로 내보내면서 답을 모은다.
      let rest = '';
      upRes.on('data', (chunk) => {
        res.write(chunk);
        rest += chunk.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            collectDelta(JSON.parse(payload), job);
          } catch (e) {
            // 조각이 깨졌으면 건너뛴다
          }
        }
      });
      upRes.on('end', () => {
        // 스트리밍이 아니면 한 덩어리로 왔으니 여기서 한 번 읽는다.
        if (!job.answer && rest.trim()) {
          try {
            collectDelta(JSON.parse(rest), job);
          } catch (e) {
            // JSON이 아니면 둔다
          }
        }
        res.end();
        finish(job);
      });
      upRes.on('error', (e) => {
        job.error = e.message;
        res.end();
        finish(job);
      });
    }
  );

  up.on('error', (e) => {
    if (job) {
      job.error = e.message;
      finish(job);
    }
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `llama-server에 닿지 못했다: ${e.message}` } }));
  });

  // 보내는 쪽이 끊으면 위쪽도 끊는다.
  res.on('close', () => {
    if (res.writableEnded) return;
    if (job && !job.endedAt) {
      job.canceled = true;
      up.destroy();
    }
  });

  if (bodyBuf && bodyBuf.length) up.write(bodyBuf);
  up.end();
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'API 키가 맞지 않다' } }));
}

async function handle(req, res) {
  const address = cleanAddress(req.socket.remoteAddress);
  const urlPath = (req.url || '').split('?')[0];

  // 프록시 자신의 상태. 키가 있으면 키를 요구한다.
  if (urlPath === '/llmbench/status') {
    if (!checkKey(req)) return unauthorized(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(status()));
    return;
  }

  // llama-server 상태와 최근 로그. 클라이언트가 서버 PC 앞에 안 가도 볼 수 있게 한다.
  if (urlPath === '/llmbench/server') {
    if (!checkKey(req)) return unauthorized(res);
    let data = { status: null, logs: [] };
    try {
      data = opts.serverInfo ? await opts.serverInfo() : data;
    } catch (e) {
      data = { status: null, logs: [], error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  // 기록 조회. 클라이언트가 터널 너머에서 부른다.
  if (urlPath === '/llmbench/log/days' || urlPath === '/llmbench/log') {
    if (!checkKey(req)) return unauthorized(res);
    const q = new URL(req.url, 'http://x').searchParams;
    const data = urlPath === '/llmbench/log'
      ? await readLog(q.get('day') || '')
      : await logDays();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (opts.apiKey && address !== '127.0.0.1' && !checkKey(req)) return unauthorized(res);

  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }

  if (!CHAT_PATHS.has(urlPath)) {
    forward(req, res, bodyBuf, null);
    return;
  }

  let body = null;
  try {
    body = JSON.parse(bodyBuf.toString('utf8'));
  } catch (e) {
    body = null;
  }

  // 스트리밍은 옵션을 켜야 마지막 조각에 토큰 수와 걸린 시간이 실린다.
  // 클라이언트가 안 켜도 기록이 남게 여기서 붙인다.
  if (body && body.stream) {
    const opt = Object.assign({}, body.stream_options, { include_usage: true });
    if (JSON.stringify(opt) !== JSON.stringify(body.stream_options)) {
      body.stream_options = opt;
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
    }
  }

  const job = {
    id: ++seq,
    at: Date.now(),
    address,
    who: whoIs(address),
    model: (body && body.model) || '',
    prompt: promptOf(body),
    answer: '',
    reasoning: '',
    tokens: 0,
    promptTokens: 0,
    promptMs: 0,
    genMs: 0,
    startedAt: null,
    endedAt: null,
    canceled: false,
    error: null,
    aborted: false,
    go: () => forward(req, res, bodyBuf, job)
  };

  // 줄 서 있는 동안 상대가 끊으면 자리를 뺀다.
  res.on('close', () => {
    if (job.startedAt) return;
    job.aborted = true;
    const i = waiting.indexOf(job);
    if (i >= 0) waiting.splice(i, 1);
    emit();
  });

  waiting.push(job);
  emit();
  pump();
}

function checkKey(req) {
  if (!opts.apiKey) return true;
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer /, '') === opts.apiKey;
}

// ---------- 켜고 끄기 ----------

function start(o) {
  stop();
  opts = {
    upstream: o.upstream,
    apiKey: o.apiKey || null,
    logDir: o.logDir || null,
    peers: o.peers || [],
    // 서버 상태와 로그를 돌려주는 함수. 셋업 앱이 넣어 준다.
    serverInfo: o.serverInfo || null,
    limit: o.limit || 1,
    // 0을 주면 빈 포트를 골라 준다. 검사에서 쓴다.
    port: Number.isInteger(o.port) ? o.port : PORT,
    host: o.share ? SHARE_HOST : HOST
  };
  lastError = null;
  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    });
  });
  // 오래 걸리는 생성이 끊기지 않게 한다.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120000;
  server.listen(opts.port, opts.host);
  server.on('error', (e) => {
    // 8080을 다른 프로그램이 이미 쓰고 있으면 여기로 온다. 조용히 넘어가면
    // 그 프로그램이 대신 응답해서 원인을 찾기 어렵다.
    lastError = e.code === 'EADDRINUSE'
      ? `${opts.port} 포트를 다른 프로그램이 쓰고 있다. 그 프로그램을 끄고 서버를 다시 시작한다.`
      : e.message;
    emit();
  });
  server.on('listening', () => {
    lastError = null;
    emit();
  });
  emit();
  return status();
}

function address() {
  return server && server.listening ? server.address() : null;
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch (e) {
      // 이미 닫혔다
    }
    server = null;
  }
  running.clear();
  waiting.length = 0;
  emit();
}

// 피어 목록이 바뀌면 이름도 바뀐다.
function setPeers(peers) {
  if (opts) opts.peers = peers || [];
}

function setLimit(n) {
  if (opts) opts.limit = Math.max(1, Number(n) || 1);
  pump();
}

module.exports = {
  PORT, start, stop, status, address, onEvent, setPeers, setLimit, readLog, logDays,
  // 테스트에서 쓴다
  _internal: { promptOf, collectDelta, cleanAddress }
};
