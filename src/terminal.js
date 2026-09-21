'use strict';
// 앱 안에서 쓰는 터미널. ConPTY로 프로세스를 띄우고 입출력을 그대로 주고받는다.
// 콘솔 창을 따로 띄우지 않고 하네스 CLI를 앱 화면에서 쓰려고 만들었다.

// 네이티브 모듈이라 업데이트로 받은 설치본에는 없을 수 있다.
// 없으면 터미널만 못 쓰게 두고 앱은 그대로 뜬다.
let pty = null;
let loadError = null;
try {
  pty = require('@lydell/node-pty');
} catch (e) {
  loadError = e.message;
}

function available() {
  return { ok: !!pty, error: loadError };
}

const SHELL = process.env.COMSPEC || 'cmd.exe';
// 화면을 다시 그릴 때 쓰려고 마지막 출력을 들고 있는다. 너무 길면 앞을 버린다.
const BUFFER_MAX = 200000;

const sessions = new Map();
let listener = null;

function onEvent(cb) {
  listener = cb;
}

function emit(type, id, payload) {
  if (listener) listener({ type, id, ...payload });
}

function start(id, opts) {
  if (!pty) throw new Error(`터미널 모듈을 불러오지 못했다. 새 포터블 zip을 받아야 한다: ${loadError}`);
  if (sessions.has(id)) return { ok: true, reused: true };
  const o = opts || {};
  const p = pty.spawn(o.file || SHELL, o.args || [], {
    name: 'xterm-256color',
    cols: o.cols || 100,
    rows: o.rows || 30,
    cwd: o.cwd || process.env.USERPROFILE || process.cwd(),
    env: { ...process.env, ...(o.env || {}) }
  });

  const s = { p, buf: '' };
  sessions.set(id, s);

  p.onData((d) => {
    s.buf += d;
    if (s.buf.length > BUFFER_MAX) s.buf = s.buf.slice(-BUFFER_MAX);
    emit('data', id, { data: d });
  });
  p.onExit(({ exitCode }) => {
    sessions.delete(id);
    emit('exit', id, { exitCode });
  });

  return { ok: true, reused: false, pid: p.pid };
}

function write(id, data) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: '터미널이 없다' };
  s.p.write(data);
  return { ok: true };
}

function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  // 0 이하를 넘기면 pty가 죽는다.
  s.p.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
  return { ok: true };
}

function kill(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  try {
    s.p.kill();
  } catch (e) {
    // 이미 끝난 경우
  }
  sessions.delete(id);
  return { ok: true };
}

// 화면을 다시 열었을 때 지금까지 출력을 돌려준다.
function snapshot(id) {
  const s = sessions.get(id);
  return { running: !!s, buf: s ? s.buf : '' };
}

function list() {
  return [...sessions.keys()];
}

function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}

module.exports = { available, start, write, resize, kill, snapshot, list, killAll, onEvent };
