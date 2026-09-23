'use strict';
// 클라이언트 쪽 WireGuard 터널. 초대 코드에 든 설정으로 터널을 만들고 올린다.
// 서버 앱의 wireguard.js와 달리 피어를 만들지 않는다. 받은 설정을 그대로 쓴다.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const wireguard = require('../wireguard');
const sys = require('../sys');

const DIR = 'C:\\Program Files\\WireGuard';
const WG = path.join(DIR, 'wg.exe');
const WGEXE = path.join(DIR, 'wireguard.exe');
const TUNNEL = 'llmbench-client';

function dataDir() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    // electron 밖에서 부를 때
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'llmbench-client');
}

function statePath() {
  return path.join(dataDir(), 'connection.json');
}

function confPath() {
  return path.join(dataDir(), `${TUNNEL}.conf`);
}

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

function installed() {
  return fs.existsSync(WG) && fs.existsSync(WGEXE);
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(s) {
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(s, null, 2), 'utf8');
  await run('icacls', [statePath(), '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]);
}

function conf(s) {
  return [
    '[Interface]',
    `PrivateKey = ${s.privateKey}`,
    `Address = ${s.address}/32`,
    '',
    '[Peer]',
    `PublicKey = ${s.serverPublicKey}`,
    `AllowedIPs = ${s.subnet}`,
    `Endpoint = ${s.endpoint}`,
    'PersistentKeepalive = 25',
    ''
  ].join('\n');
}

// 초대 코드를 받아 저장한다. 터널을 올리지는 않는다.
async function applyInvite(code) {
  const p = wireguard.parseInvite(code);
  await writeState(p);
  return { name: p.name, serverAddress: p.serverAddress, endpoint: p.endpoint };
}

// /uninstalltunnelservice는 요청만 하고 바로 돌아온다. 서비스가 실제로 없어지기 전에
// 다시 올리면 "Tunnel already installed and running"으로 막힌다. 사라질 때까지 기다린다.
async function waitGone(name, ms) {
  const until = Date.now() + (ms || 15000);
  for (;;) {
    const r = await run(WG, ['show', name, 'dump']);
    if (r.code !== 0) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function up() {
  if (!installed()) throw new Error('WireGuard가 설치돼 있지 않다');
  const s = await readState();
  if (!s) throw new Error('초대 코드를 먼저 넣는다');
  await fsp.writeFile(confPath(), conf(s), 'utf8');
  await down().catch(() => {});
  if (!(await waitGone(TUNNEL))) throw new Error('앞서 올라간 터널이 안 내려간다. 잠시 뒤 다시 누른다.');
  const r = await run(WGEXE, ['/installtunnelservice', confPath()]);
  if (r.code !== 0) {
    // 터널 서비스를 등록하려면 관리자 권한이 있어야 한다. 그게 원인인 경우가 흔하다.
    const admin = await sys.isAdmin().catch(() => true);
    const hint = admin ? '' : ' 관리자 권한으로 다시 실행한다.';
    throw new Error(`터널을 올리지 못했다: ${r.err || r.out || r.code}.${hint}`);
  }
  return { ok: true };
}

async function down() {
  const r = await run(WGEXE, ['/uninstalltunnelservice', TUNNEL]);
  return { ok: r.code === 0 };
}

async function status() {
  const s = await readState();
  // 어디로 붙으려 하는지 같이 준다. 안 붙을 때 주소부터 보게 된다.
  const ep = s ? s.endpoint : null;
  if (!installed()) return { installed: false, configured: !!s, running: false, endpoint: ep };
  const r = await run(WG, ['show', TUNNEL, 'dump']);
  if (r.code !== 0) return { installed: true, configured: !!s, running: false, endpoint: ep };
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  const f = (lines[1] || '').split('\t');
  const handshake = Number(f[4]) || 0;
  return {
    installed: true,
    configured: !!s,
    running: true,
    endpoint: ep,
    lastHandshake: handshake ? new Date(handshake * 1000).toISOString() : null,
    rxBytes: Number(f[5]) || 0,
    txBytes: Number(f[6]) || 0
  };
}

// 서버 주소와 키. 대화와 하네스가 이걸 쓴다.
async function target() {
  const s = await readState();
  if (!s) return null;
  // 연결 정보에 저장된 포트가 있으면 그걸 쓴다. 없으면 기존처럼 8080.
  const port = Number(s.apiPort) || Number(s.port) || 8080;
  return { baseUrl: `http://${s.serverAddress}:${port}`, apiKey: s.apiKey, name: s.name };
}

// 서버 프록시에 물어본다. 상태와 기록 조회에 쓴다.
async function ask(pathname, params, method, body) {
  const t = await target();
  if (!t) throw new Error('서버에 연결돼 있지 않다');
  const url = new URL(pathname, t.baseUrl);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    let why = '';
    try {
      const j = await res.json();
      why = j && j.error && j.error.message ? `: ${j.error.message}` : '';
    } catch (e) {
      why = '';
    }
    throw new Error(`서버가 ${res.status}로 답했다${why}`);
  }
  return res.json();
}

// 서버 PC의 llama-server를 켜고 끈다. 셋업 앱 업데이트도 시킨다.
function serverStart() {
  return ask('/llmbench/server/start', null, 'POST');
}
function serverStop() {
  return ask('/llmbench/server/stop', null, 'POST');
}
function serverUpdateCheck() {
  return ask('/llmbench/update/check');
}
function serverUpdateApply() {
  return ask('/llmbench/update/apply', null, 'POST');
}

// 서버 PC의 벤치. 결과를 읽고, 시키고, 멈춘다.
function benchInfo() {
  return ask('/llmbench/bench');
}
function benchRun(opts) {
  return ask('/llmbench/bench/run', null, 'POST', opts || {});
}
function benchCancel() {
  return ask('/llmbench/bench/cancel', null, 'POST');
}
function benchApply() {
  return ask('/llmbench/bench/apply', null, 'POST');
}

function serverStatus() {
  return ask('/llmbench/status');
}

function serverInfo() {
  return ask('/llmbench/server');
}

function serverLogDays() {
  return ask('/llmbench/log/days');
}

function serverLog(day) {
  return ask('/llmbench/log', { day });
}

async function forget() {
  await down().catch(() => {});
  await fsp.rm(statePath(), { force: true });
  await fsp.rm(confPath(), { force: true });
  return { ok: true };
}

module.exports = {
  installed, applyInvite, up, down, status, target, forget, conf, statePath, confPath, TUNNEL,
  serverStatus, serverLogDays, serverLog, serverInfo,
  serverStart, serverStop, serverUpdateCheck, serverUpdateApply,
  benchInfo, benchRun, benchCancel, benchApply
};
