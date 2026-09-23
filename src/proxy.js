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
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
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
// 누가 서버를 켜고 끄고 업데이트했는지. 화면에 보여주고 파일에도 남긴다.
const events = [];
const EVENTS_MAX = 50;
const ACTION_NAMES = {
  '/llmbench/server/start': '서버 켜기',
  '/llmbench/server/stop': '서버 끄기',
  '/llmbench/update/check': '업데이트 확인',
  '/llmbench/update/apply': '앱 업데이트',
  '/llmbench/bench/run': '벤치 시작',
  '/llmbench/bench/apply': '벤치 결과 적용',
  '/llmbench/bench/cancel': '벤치 중지',
  '/llmbench/warm/clear': '예열 파일 비우기'
};

// 하네스가 보내는 요청은 시스템 프롬프트와 도구 정의만 1만 토큰이 넘고 매번 같다.
// 서버를 다시 켠 뒤 첫 사람이 1분 넘게 기다리지 않게, 하네스별 시스템 프롬프트와
// 도구 정의를 파일에 두고 예열에 쓴다. 사람 질문은 남기지 않는다.
const WARM_MIN_CHARS = 4000;
const WARM_MAX_FILES = 6;
const warmSeen = new Map();

// 하네스마다 시스템 프롬프트가 다르니 파일도 따로 둔다. 모델 이름과 시스템 프롬프트 전체 해시.
// 같은 하네스라도 실행 방식(대화형, -p)에 따라 뒷부분이 달라서 앞부분만 보면 서로 덮어쓴다.
function warmKey(model, messages) {
  const head = textOf(messages[0].content);
  const hash = crypto.createHash('sha1').update(head).digest('hex').slice(0, 8);
  return `${model.replace(/[^\w.-]/g, '_')}-${hash}`;
}

function warmDir() {
  return opts && opts.logDir ? path.join(opts.logDir, '..', 'warm') : null;
}

// 프롬프트 렌더링에 영향을 주는 요청 필드. 예열 요청에 그대로 실어야 토큰이 같다.
const WARM_KEEP_FIELDS = ['tools', 'tool_choice', 'chat_template_kwargs', 'reasoning_effort', 'response_format'];

// 예열에 보낼 대화. 시스템 프롬프트 뒤 질문 칸은 "."로 채운다.
// 이 모델은 캐시를 사용자 메시지가 시작하는 곳까지만 되살리고 질문 칸은 매번 새로 읽는다.
// 그래서 사람 질문을 넣어 예열해도 얻는 것이 없다. "."로 바꿔도 다음 질문이 읽는 토큰 수가 같았다.
// 사용자 메시지를 아예 빼는 방식은 시험하지 않았다.
function warmMessages(messages) {
  return [messages[0], { role: 'user', content: '.' }];
}

async function keepSystemPrompt(body) {
  const dir = warmDir();
  if (!dir || !body || !Array.isArray(body.messages) || typeof body.model !== 'string') return;
  if (body.messages.some((m) => !m || typeof m !== 'object' || typeof m.role !== 'string')) return;
  let lastUser = -1;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i] && body.messages[i].role === 'user') { lastUser = i; break; }
  }
  // 첫 턴만 쓴다. 대화가 이어지면 시스템 프롬프트에 그 세션 내용을 덧붙이는 하네스가 있다.
  if (lastUser !== 1 || body.messages[0].role !== 'system') return;
  // 질문이 빠지니 같은 하네스의 첫 턴은 내용이 같다. 새 세션마다 파일을 다시 쓰지 않는다.
  const head = { messages: warmMessages(body.messages) };
  for (const k of WARM_KEEP_FIELDS) if (body[k] !== undefined) head[k] = body[k];
  const text = JSON.stringify(head);
  const key = warmKey(body.model, body.messages);
  if (text.length < WARM_MIN_CHARS) return;
  const file = path.join(dir, `${key}.json`);
  if (warmSeen.get(key) === text) {
    // 같은 내용이면 다시 쓰지 않고 최근 사용 표시만 갱신한다. 예열 순서와 정리 기준이 이 시각이다.
    // 파일이 밖에서 지워졌으면 갱신이 실패하니 그때는 아래로 내려가 다시 쓴다.
    const now = new Date();
    const touched = await fsp.utimes(file, now, now).then(() => true, () => false);
    if (touched) return;
    warmSeen.delete(key);
  }
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(Object.assign({ model: body.model, at: new Date().toISOString() }, head)), 'utf8');
    warmSeen.set(key, text);
    // 오래된 것부터 지워 개수를 맞춘다. 안 쓰는 하네스 예열에 시간을 쓰지 않게.
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
    if (files.length > WARM_MAX_FILES) {
      const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fsp.stat(path.join(dir, f))).mtimeMs })));
      stats.sort((a, b) => a.t - b.t);
      for (const old of stats.slice(0, stats.length - WARM_MAX_FILES)) {
        await fsp.unlink(path.join(dir, old.f)).catch(() => {});
        warmSeen.delete(old.f.replace(/\.json$/, ''));
      }
    }
  } catch (e) {
    // 못 남겨도 대화에는 지장 없다
  }
}

async function warmPrompts() {
  const dir = warmDir();
  if (!dir) return [];
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  // 최근에 쓴 것부터. 예열이 오래 걸리니 자주 쓰는 하네스가 먼저 준비된다.
  const stats = await Promise.all(names.filter((f) => f.endsWith('.json')).map(async (f) => ({ f, t: (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  for (const n of stats.map((x) => x.f)) {
    try {
      const w = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      // 예전 파일에는 사람 질문이 들어 있다. 보낼 때도 질문 칸을 비운다.
      if (Array.isArray(w.messages) && w.messages.length) w.messages = warmMessages(w.messages);
      out.push(w);
    } catch (e) {
      // 깨진 파일은 건너뛴다
    }
  }
  return out;
}

// 예열 파일 목록. 서버 PC 앞에 가지 않고 무엇이 예열되는지 본다.
async function warmList() {
  const dir = warmDir();
  if (!dir) return [];
  const names = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of names) {
    try {
      const st = await fsp.stat(path.join(dir, f));
      const w = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      const msgs = Array.isArray(w.messages) ? w.messages : [];
      out.push({
        file: f,
        model: w.model,
        at: w.at,
        used: st.mtime.toISOString(),
        size: st.size,
        tools: Array.isArray(w.tools) ? w.tools.length : 0,
        system: msgs[0] ? textOf(msgs[0].content).slice(0, 60) : ''
      });
    } catch (e) {
      out.push({ file: f, error: e.message });
    }
  }
  out.sort((a, b) => String(b.used || '').localeCompare(String(a.used || '')));
  return out;
}

// 예열 파일을 모두 지운다. 시험 삼아 띄운 세션의 첫 턴이 쌓여 실제 하네스 예열을 밀어낼 때 쓴다.
// 지운 뒤 각 하네스의 다음 첫 턴이 다시 남긴다.
async function warmClear() {
  const dir = warmDir();
  let removed = 0;
  if (dir) {
    const names = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
    for (const f of names) {
      if (await fsp.unlink(path.join(dir, f)).then(() => true, () => false)) removed++;
    }
  }
  warmSeen.clear();
  return { ok: true, removed };
}

async function recordEvent(ev) {
  events.unshift(ev);
  while (events.length > EVENTS_MAX) events.pop();
  emit();
  if (!opts || !opts.logDir) return;
  try {
    await fsp.mkdir(opts.logDir, { recursive: true });
    await fsp.appendFile(path.join(opts.logDir, 'control.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  } catch (e) {
    // 파일에 못 남겨도 화면에는 남는다
  }
}

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
    recent: recent.map(view),
    events: events.slice()
  };
}

// start: 아직 아무 조각도 안 왔다. 모델을 올리는 중일 수 있다.
// prompt: 프롬프트를 읽고 있다. gen: 답을 쓰고 있다. done: 끝났다.
function stageOf(j) {
  if (j.endedAt) return 'done';
  if (!j.startedAt) return 'wait';
  if (j.tokens > 0 || j.answer || j.reasoning || (j.tools && j.tools.length)) return 'gen';
  if (j.progress && j.progress.processed < j.progress.total) return 'prompt';
  if (j.progress) return 'gen';
  return 'start';
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
    reasoningChars: j.reasoning ? j.reasoning.length : 0,
    toolCalls: j.tools ? j.tools.length : 0,
    tokens: j.tokens || 0,
    // 어느 단계인지. 화면에서 "프롬프트 읽는 중 61%" 같은 문구를 만든다.
    stage: stageOf(j),
    promptPct: j.progress && j.progress.total ? Math.round((j.progress.processed / j.progress.total) * 100) : null,
    promptTokens: j.promptTokens || (j.progress ? j.progress.total : 0),
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
    answer: job.answer || '',
    reasoning: job.reasoning || '',
    tools: (job.tools || []).map((t) => ({ name: t.name, args: t.args }))
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return [];
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

// 진행률 말고는 아무것도 없는 조각인지. 이런 조각은 llama-server가 우리 요청으로 붙인 것이다.
function isProgressOnly(json) {
  if (!json.prompt_progress) return false;
  if (json.usage || json.timings) return false;
  for (const c of json.choices || []) {
    if (!c) continue;
    if (c.finish_reason || typeof c.text === 'string') return false;
    const d = c.delta || c.message;
    if (d && (d.content || d.reasoning_content || d.tool_calls || d.role)) return false;
  }
  return true;
}

// 스트리밍 조각에서 답 글자를 모은다. 생각 과정은 답과 나눠 둔다.
// 토큰 수와 걸린 시간이 실린 마지막 조각은 choices가 빈 배열로 오니
// choices를 보기 전에 먼저 챙긴다.
function collectDelta(json, job) {
  if (json.prompt_progress && json.prompt_progress.total) {
    job.progress = {
      total: json.prompt_progress.total,
      processed: json.prompt_progress.processed || 0,
      cache: json.prompt_progress.cache || 0
    };
  }
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

  const c = json.choices && json.choices[0];
  if (!c) return;
  const d = c.delta || c.message || {};
  if (typeof d.content === 'string') job.answer += d.content;
  if (typeof d.reasoning_content === 'string') job.reasoning += d.reasoning_content;
  if (typeof c.text === 'string') job.answer += c.text;
  // 하네스는 글 대신 도구 호출로 답하는 일이 많다. 이름과 인자를 순서대로 모은다.
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      const idx = Number.isInteger(tc.index) ? tc.index : job.tools.length;
      while (job.tools.length <= idx) job.tools.push({ name: '', args: '' });
      const f = tc.function || {};
      if (typeof f.name === 'string') job.tools[idx].name += f.name;
      if (typeof f.arguments === 'string') job.tools[idx].args += f.arguments;
    }
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

// 스트리밍이 아닌 응답을 기록하려고 모아 두는 한도. 넘으면 전달만 하고 기록은 건너뛴다.
const RESPONSE_LOG_MAX = 8 * 1024 * 1024;

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
      const isSse = String(upRes.headers['content-type'] || '').includes('text/event-stream');
      const headers = Object.assign({}, upRes.headers);
      // 진행률 조각을 걷어 내면 길이가 줄어드니 SSE는 길이 헤더를 빼고 chunked로 보낸다.
      if (job && isSse) delete headers['content-length'];
      res.writeHead(upRes.statusCode || 502, headers);
      if (!job) {
        upRes.pipe(res);
        return;
      }
      if (!isSse) {
        // 스트리밍이 아니면 원본을 그대로 흘리고, 기록용으로만 한도 안에서 모아 끝에 한 번 읽는다.
        const parts = [];
        let total = 0;
        upRes.on('data', (chunk) => {
          res.write(chunk);
          total += chunk.length;
          if (total <= RESPONSE_LOG_MAX) parts.push(chunk);
        });
        upRes.on('end', () => {
          if (total > RESPONSE_LOG_MAX) {
            job.error = `응답이 ${RESPONSE_LOG_MAX}바이트를 넘어 기록하지 않음`;
          } else {
            try {
              collectDelta(JSON.parse(Buffer.concat(parts).toString('utf8')), job);
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
        return;
      }
      // 줄 단위로 읽어 답을 모으고 내보낸다. 진행률만 실린 조각은 우리가 붙이라고 한 것이라
      // 하네스에는 넘기지 않는다. 글자가 조각 경계에서 갈려도 깨지지 않게 디코더를 쓴다.
      const decoder = new StringDecoder('utf8');
      let rest = '';
      upRes.on('data', (chunk) => {
        rest += decoder.write(chunk);
        const lines = rest.split('\n');
        rest = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith('data:') && t.slice(5).trim() !== '[DONE]') {
            try {
              const json = JSON.parse(t.slice(5).trim());
              collectDelta(json, job);
              if (isProgressOnly(json)) continue;
            } catch (e) {
              // 조각이 깨졌으면 그대로 넘긴다
            }
          }
          res.write(line + '\n');
        }
      });
      upRes.on('end', () => {
        rest += decoder.end();
        if (rest) res.write(rest);
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

  // 서버 켜기, 끄기, 앱 업데이트. 셋업 앱이 넣어 준 함수를 부른다.
  // 상태를 바꾸는 것은 POST만 받는다. 키를 가진 사람은 누구나 부를 수 있다.
  const control = opts.control || {};
  const actions = {
    '/llmbench/server/start': { fn: control.startServer, post: true },
    '/llmbench/server/stop': { fn: control.stopServer, post: true },
    '/llmbench/update/check': { fn: control.updateCheck, post: false },
    '/llmbench/update/apply': { fn: control.updateApply, post: true },
    '/llmbench/bench/run': { fn: control.benchRun, post: true },
    '/llmbench/bench/cancel': { fn: control.benchCancel, post: true },
    '/llmbench/bench/apply': { fn: control.benchApply, post: true },
    '/llmbench/warm': { fn: warmList, post: false },
    '/llmbench/warm/clear': { fn: warmClear, post: true }
  };
  if (actions[urlPath]) {
    if (!checkKey(req)) return unauthorized(res);
    const a = actions[urlPath];
    if (a.post && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'POST로 부른다' } }));
      return;
    }
    if (!a.fn) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '이 서버는 그 동작을 지원하지 않는다' } }));
      return;
    }
    // 본문이 있으면 JSON으로 읽어 넘긴다. 벤치 시작이 모델과 모드를 이렇게 받는다.
    let payload = null;
    try {
      const buf = await readBody(req);
      if (buf.length) payload = JSON.parse(buf.toString('utf8'));
      if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) throw new Error('본문은 JSON 객체여야 한다');
    } catch (e) {
      // 본문이 깨졌으면 동작을 시키지 않는다. 벤치가 기본값으로 시작되는 일을 막는다.
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `본문을 읽지 못함: ${e.message}` } }));
      return;
    }
    let out;
    const who = whoIs(address);
    try {
      out = await a.fn({ who, address }, payload);
    } catch (e) {
      // 확인은 상태를 안 바꾸니 남기지 않는다.
      if (a.post) recordEvent({ at: new Date().toISOString(), who, address, action: ACTION_NAMES[urlPath], ok: false, error: e.message });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: e.message } }));
      return;
    }
    // 예외 없이 { ok: false }로 실패를 돌려주는 동작도 실패로 남긴다.
    const failed = out && out.ok === false;
    if (a.post) recordEvent({ at: new Date().toISOString(), who, address, action: ACTION_NAMES[urlPath], ok: !failed, error: failed ? (out.error || '실패') : null });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out === undefined ? { ok: true } : out));
    return;
  }

  // 벤치 결과. 돌고 있으면 진행 글도 같이 준다.
  if (urlPath === '/llmbench/bench') {
    if (!checkKey(req)) return unauthorized(res);
    let data = { busy: false, progress: null, last: null };
    try {
      data = opts.benchInfo ? await opts.benchInfo() : data;
    } catch (e) {
      data.error = e.message;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
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
    data.events = events.slice();
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

  // 서버가 한 번에 한 모델만 올리니, 막아 둔 모델을 부르면 다른 사람의 모델과 캐시가 내려간다.
  if (body && opts.blockModels && opts.blockModels.includes(body.model)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: `${body.model}은 이 서버에서 쓰지 않는다. qwen38을 쓴다.` } }));
    return;
  }

  keepSystemPrompt(body).catch(() => {});

  // 스트리밍은 옵션을 켜야 마지막 조각에 토큰 수와 걸린 시간이 실린다.
  // 클라이언트가 안 켜도 기록이 남게 여기서 붙인다.
  // 프롬프트 읽기 진행률도 달아 달라고 한다. 그 조각은 여기서 걷어 내고 화면에만 쓴다.
  if (body && body.stream) {
    const opt = Object.assign({}, body.stream_options, { include_usage: true });
    if (JSON.stringify(opt) !== JSON.stringify(body.stream_options) || body.return_progress !== true) {
      body.stream_options = opt;
      body.return_progress = true;
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
    tools: [],
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
    // 켜기, 끄기, 업데이트 함수 묶음. 없으면 그 경로는 501을 준다.
    control: o.control || null,
    // 벤치 결과와 진행 상황을 주는 함수.
    benchInfo: o.benchInfo || null,
    // 이 서버에서 부르지 못하게 막는 모델 이름들.
    blockModels: Array.isArray(o.blockModels) ? o.blockModels : [],
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
  PORT, start, stop, status, address, onEvent, setPeers, setLimit, readLog, logDays, warmPrompts, recordEvent,
  // 테스트에서 쓴다
  _internal: { promptOf, collectDelta, cleanAddress }
};
