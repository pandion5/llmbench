'use strict';
// WireGuard 터널을 만들고 llama-server를 그 대역에서만 쓰게 한다.
// 키는 config.json과 따로 둔다. 설정 내보내기로 개인 키가 새어 나가지 않게 하기 위해서다.

const fs = require('fs');
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');

const DIR = 'C:\\Program Files\\WireGuard';
const WG = path.join(DIR, 'wg.exe');
const WGEXE = path.join(DIR, 'wireguard.exe');
// 터널 이름은 conf 파일명이 그대로 쓰인다.
const TUNNEL = 'llmbench';
const PORT = 51820;
const SUBNET = '10.66.0';
const RULE = 'llmbench WireGuard';
// llama-server가 듣는 포트. 터널 대역에서 오는 것만 연다.
const API_RULE = 'llmbench API (WireGuard only)';
const API_PORT = 8080;

function statePath() {
  return path.join(config.userDataDir(), 'wireguard.json');
}

function confPath() {
  return path.join(config.userDataDir(), `${TUNNEL}.conf`);
}

// 실행 결과를 그대로 돌려준다. 실패해도 예외를 던지지 않고 code를 본다.
function run(file, args, input) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function installed() {
  return fs.existsSync(WG) && fs.existsSync(WGEXE);
}

async function version() {
  if (!installed()) return null;
  const r = await run(WG, ['--version']);
  return r.out || r.err || null;
}

async function genKeyPair() {
  const priv = (await run(WG, ['genkey'])).out;
  if (!priv) throw new Error('개인 키를 만들지 못했다');
  const pub = (await run(WG, ['pubkey'], priv)).out;
  if (!pub) throw new Error('공개 키를 만들지 못했다');
  return { privateKey: priv, publicKey: pub };
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(s) {
  await fsp.mkdir(path.dirname(statePath()), { recursive: true });
  await fsp.writeFile(statePath(), JSON.stringify(s, null, 2), 'utf8');
  // 키가 들어 있으니 다른 계정이 못 읽게 상속을 끊고 현재 사용자만 남긴다.
  await run('icacls', [statePath(), '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]);
}

// 서버 키와 API 키를 만들어 둔다. 이미 있으면 그대로 쓴다.
async function ensureState() {
  let s = await readState();
  if (s && s.server && s.server.privateKey) return s;
  const kp = await genKeyPair();
  s = {
    server: { ...kp, address: `${SUBNET}.1`, port: PORT },
    // llama-server에 걸 키. 터널 안이라도 한 겹 더 둔다.
    apiKey: (await run(WG, ['genkey'])).out.replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
    peers: [],
    endpoint: '',
    // 서버를 터널에 열지 여부. 화면 체크만 두면 앱을 껐다 켤 때 풀린다.
    serve: false
  };
  await writeState(s);
  return s;
}

function serverConf(s) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${s.server.privateKey}`,
    `Address = ${s.server.address}/24`,
    `ListenPort = ${s.server.port}`,
    ''
  ];
  for (const p of s.peers) {
    lines.push('[Peer]', `# ${p.name}`, `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.address}/32`, '');
  }
  return lines.join('\n');
}

// 클라이언트에 줄 설정. 터널 대역만 태워서 다른 통신은 평소대로 나가게 한다.
function clientConf(s, peer, endpoint) {
  return [
    '[Interface]',
    `PrivateKey = ${peer.privateKey}`,
    `Address = ${peer.address}/32`,
    '',
    '[Peer]',
    `PublicKey = ${s.server.publicKey}`,
    `AllowedIPs = ${SUBNET}.0/24`,
    `Endpoint = ${endpoint || '<이 PC의 공인 IP>'}:${s.server.port}`,
    'PersistentKeepalive = 25',
    ''
  ].join('\n');
}

function nextAddress(s) {
  const used = new Set(s.peers.map((p) => p.address));
  for (let i = 2; i < 250; i++) {
    const a = `${SUBNET}.${i}`;
    if (!used.has(a)) return a;
  }
  throw new Error('남은 주소가 없다');
}

async function addPeer(name) {
  const s = await ensureState();
  // 이름은 서버 설정 파일에 주석으로 들어간다. 줄을 넘기는 문자는 빼고 받는다.
  const clean = String(name || '').replace(/[\r\n#\[\]=]/g, ' ').trim().slice(0, 40) || `peer${s.peers.length + 1}`;
  if (s.peers.some((p) => p.name === clean)) throw new Error(`같은 이름의 기기가 있다: ${clean}`);
  const kp = await genKeyPair();
  const peer = { name: clean, address: nextAddress(s), ...kp };
  s.peers.push(peer);
  await writeState(s);
  return peer;
}

async function removePeer(name) {
  const s = await ensureState();
  s.peers = s.peers.filter((p) => p.name !== name);
  await writeState(s);
  return { ok: true };
}

async function setServe(on) {
  const s = await ensureState();
  s.serve = !!on;
  await writeState(s);
  return { serve: s.serve };
}

async function serve() {
  const s = await readState();
  return !!(s && s.serve);
}

async function setEndpoint(endpoint) {
  const s = await ensureState();
  s.endpoint = String(endpoint || '').trim();
  await writeState(s);
  return { endpoint: s.endpoint };
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

// 터널 서비스를 올린다. 설정이 바뀌면 내렸다가 다시 올린다.
async function up() {
  if (!installed()) throw new Error('WireGuard가 설치돼 있지 않다');
  const s = await ensureState();
  await fsp.writeFile(confPath(), serverConf(s), 'utf8');
  await down().catch(() => {});
  if (!(await waitGone(TUNNEL))) throw new Error('앞서 올라간 터널이 안 내려간다. 잠시 뒤 다시 누른다.');
  const r = await run(WGEXE, ['/installtunnelservice', confPath()]);
  if (r.code !== 0) throw new Error(`터널을 올리지 못했다: ${r.err || r.out || r.code}`);
  const fw = await allowFirewall();
  const blocked = await blockingRules().catch(() => []);
  const out = { ok: true, tunnel: TUNNEL };
  if (!fw.ok) out.firewallError = fw.detail || '방화벽 규칙을 넣지 못했다';
  if (blocked.length) out.blocked = blocked;
  return out;
}

async function down() {
  const r = await run(WGEXE, ['/uninstalltunnelservice', TUNNEL]);
  return { ok: r.code === 0, detail: r.err || r.out };
}

// llama-server를 막는 차단 규칙을 찾는다.
// 윈도우는 차단을 허용보다 먼저 적용한다. 프로그램을 처음 띄울 때 뜨는 방화벽 창에서
// 취소를 누르면 차단 규칙이 생기고, 그러면 포트를 열어도 터널에서 못 닿는다.
async function blockingRules() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$out=@();',
    'Get-NetFirewallApplicationFilter -PolicyStore ActiveStore |',
    ' Where-Object { $_.Program -like "*llama-server*" } |',
    ' ForEach-Object { $_ | Get-NetFirewallRule } |',
    ' Where-Object { $_.Action -eq "Block" -and $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" } |',
    ' ForEach-Object { $out += [pscustomobject]@{name=[string]$_.DisplayName;profile=[string]$_.Profile} };',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join(' ');
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  try {
    return JSON.parse(r.out) || [];
  } catch {
    return [];
  }
}

// 찾은 차단 규칙을 끈다. 지우지 않고 끄기만 해서 되돌릴 수 있게 둔다.
async function disableBlockingRules() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    'Get-NetFirewallApplicationFilter |',
    ' Where-Object { $_.Program -like "*llama-server*" } |',
    ' ForEach-Object { $_ | Get-NetFirewallRule } |',
    ' Where-Object { $_.Action -eq "Block" } |',
    ' Disable-NetFirewallRule'
  ].join(' ');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const left = await blockingRules();
  return { ok: left.length === 0, left };
}

// 방화벽 규칙 두 개를 넣는다. 같은 이름이 있으면 지우고 다시 만든다.
// 하나는 터널이 쓰는 UDP 포트, 하나는 llama-server가 듣는 TCP 포트다.
// TCP 쪽은 터널 대역에서 오는 것만 받게 막아 둔다. 같은 공유기의 다른 기기는 못 들어온다.
async function allowFirewall() {
  await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE}`]);
  const udp = await run('netsh', [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${RULE}`, 'dir=in', 'action=allow', 'protocol=UDP', `localport=${PORT}`
  ]);

  await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${API_RULE}`]);
  const tcp = await run('netsh', [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${API_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP',
    `localport=${API_PORT}`, `remoteip=${SUBNET}.0/24`
  ]);

  return {
    ok: udp.code === 0 && tcp.code === 0,
    detail: [udp.err || udp.out, tcp.err || tcp.out].filter(Boolean).join(' / ')
  };
}

// 서버 포트를 실제로 어느 주소에서 듣고 있는지 본다. 공유 설정이 먹었는지는
// 화면 체크값이 아니라 이걸로 판단한다.
async function listenStatus() {
  const ps = `(Get-NetTCPConnection -State Listen -LocalPort ${API_PORT} -ErrorAction SilentlyContinue | ` +
    'ForEach-Object { $_.LocalAddress }) -join ","';
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const list = String(r.out || '').trim().split(',').map((x) => x.trim()).filter(Boolean);
  return {
    port: API_PORT,
    addresses: list,
    // 0.0.0.0이나 :: 이면 터널에서도 닿는다. 127.0.0.1만 있으면 이 PC 안에서만 받는다.
    open: list.some((a) => a === '0.0.0.0' || a === '::' || a === `${SUBNET}.1`)
  };
}

// 방화벽 규칙을 본다. 이름만 맞는지가 아니라 켜져 있고 허용인지까지 본다.
// netsh 출력은 로케일마다 말이 달라 PowerShell로 값을 직접 읽는다.
async function firewallStatus() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    `$names=@('${RULE}','${API_RULE}');`,
    '$out=@();',
    'foreach($n in $names){',
    '  $r=Get-NetFirewallRule -DisplayName $n -PolicyStore ActiveStore | Select-Object -First 1;',
    '  if($r){ $out += [pscustomobject]@{name=$n;found=$true;enabled=[string]$r.Enabled;action=[string]$r.Action;direction=[string]$r.Direction;profile=[string]$r.Profile} }',
    '  else{ $out += [pscustomobject]@{name=$n;found=$false} }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join(' ');
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let rows = [];
  try {
    rows = JSON.parse(r.out);
  } catch {
    return { udp: null, tcp: null, detail: '규칙을 읽지 못했다' };
  }
  const pick = (name) => {
    const row = rows.find((x) => x.name === name);
    if (!row || !row.found) return false;
    return row.enabled === 'True' && row.action === 'Allow';
  };
  return { udp: pick(RULE), tcp: pick(API_RULE), rows };
}

// wg show dump는 탭으로 나뉜 줄을 준다. 첫 줄이 인터페이스, 나머지가 피어다.
async function status() {
  if (!installed()) return { installed: false, running: false, peers: [] };
  const r = await run(WG, ['show', TUNNEL, 'dump']);
  if (r.code !== 0) return { installed: true, running: false, peers: [] };
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  const s = await readState();
  const byKey = new Map((s ? s.peers : []).map((p) => [p.publicKey, p.name]));
  const peers = lines.slice(1).map((l) => {
    const f = l.split('\t');
    const handshake = Number(f[4]) || 0;
    return {
      publicKey: f[0],
      name: byKey.get(f[0]) || '(모르는 기기)',
      endpoint: f[2] === '(none)' ? '' : f[2],
      allowedIps: f[3],
      lastHandshake: handshake ? new Date(handshake * 1000).toISOString() : null,
      rxBytes: Number(f[5]) || 0,
      txBytes: Number(f[6]) || 0
    };
  });
  return { installed: true, running: true, tunnel: TUNNEL, listenPort: Number((lines[0] || '').split('\t')[2]) || PORT, peers };
}

// 이 PC의 내부 주소. 같은 공유기 안에서 쓸 때 접속 주소로 넣는다.
// 터널 자기 주소와 가상 어댑터가 섞여 나오므로 걸러서 준다.
function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith(`${SUBNET}.`)) continue;
      const priv =
        a.address.startsWith('192.168.') ||
        a.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(a.address);
      if (!priv) continue;
      // Hyper-V나 WSL이 만든 어댑터는 다른 PC에서 못 닿는다. 뒤로 민다.
      const virt = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Default Switch|Tailscale/i.test(name);
      out.push({ name, address: a.address, virtual: virt });
    }
  }
  out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
  return out;
}

// 공인 IP를 물어본다. 실패하면 null을 준다.
async function publicIp() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) });
    const ip = (await res.text()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

// 화면에 보여줄 묶음. 개인 키는 넣지 않는다.
async function info() {
  const s = await readState();
  const st = await status();
  return {
    installed: installed(),
    version: await version(),
    configured: !!(s && s.server),
    serverPublicKey: s ? s.server.publicKey : null,
    address: s ? s.server.address : `${SUBNET}.1`,
    port: s ? s.server.port : PORT,
    endpoint: s ? s.endpoint : '',
    serve: !!(s && s.serve),
    apiKey: s ? s.apiKey : null,
    peers: s ? s.peers.map((p) => ({ name: p.name, address: p.address, publicKey: p.publicKey })) : [],
    firewall: await firewallStatus().catch(() => ({ udp: null, tcp: null })),
    listen: await listenStatus().catch(() => null),
    blocked: await blockingRules().catch(() => []),
    status: st
  };
}

// 기기 하나의 클라이언트 설정을 텍스트로 준다. 개인 키가 들어 있으니 화면에서만 쓴다.
async function peerConf(name) {
  const s = await ensureState();
  const peer = s.peers.find((p) => p.name === name);
  if (!peer) throw new Error(`그런 기기가 없다: ${name}`);
  return clientConf(s, peer, s.endpoint);
}

// 키가 어디 찍혔거나 새어 나갔을 때 새로 만든다. 서버를 다시 시작해야 바뀐 키가 걸린다.
async function rotateApiKey() {
  const s = await ensureState();
  s.apiKey = (await run(WG, ['genkey'])).out.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  await writeState(s);
  return { apiKey: s.apiKey };
}

// 클라이언트에 한 번만 넘기는 초대. 터널 설정과 API 키, 서버 주소가 다 들어간다.
// 긴 문자열 하나라 메신저나 메모로 옮기기 쉽다. 개인 키가 들어 있으니 아무 데나 두지 않는다.
const INVITE_PREFIX = 'LLMB1.';

async function invite(name) {
  const s = await ensureState();
  const peer = s.peers.find((p) => p.name === name);
  if (!peer) throw new Error(`그런 기기가 없다: ${name}`);
  if (!s.endpoint) throw new Error('접속 주소를 먼저 저장한다');
  const payload = {
    v: 1,
    name: peer.name,
    address: peer.address,
    privateKey: peer.privateKey,
    serverPublicKey: s.server.publicKey,
    serverAddress: s.server.address,
    endpoint: `${s.endpoint}:${s.server.port}`,
    subnet: `${SUBNET}.0/24`,
    apiKey: s.apiKey
  };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parseInvite(code) {
  const t = String(code || '').trim();
  if (!t.startsWith(INVITE_PREFIX)) throw new Error('초대 코드 형식이 아니다');
  let obj;
  try {
    obj = JSON.parse(Buffer.from(t.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('초대 코드를 읽지 못했다');
  }
  const need = ['name', 'address', 'privateKey', 'serverPublicKey', 'serverAddress', 'endpoint', 'subnet', 'apiKey'];
  for (const k of need) {
    if (typeof obj[k] !== 'string' || !obj[k].trim()) throw new Error(`초대 코드에 ${k}가 없다`);
  }
  // 값이 설정 파일에 그대로 들어가고 요청 주소가 된다. 모양을 확인하고 받는다.
  const IP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const KEY = /^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/;
  if (!IP.test(obj.address)) throw new Error('초대 코드의 기기 주소가 IP 형식이 아니다');
  if (!IP.test(obj.serverAddress)) throw new Error('초대 코드의 서버 주소가 IP 형식이 아니다');
  if (!KEY.test(obj.privateKey) || !KEY.test(obj.serverPublicKey)) throw new Error('초대 코드의 키 형식이 맞지 않다');
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(obj.subnet)) throw new Error('초대 코드의 대역 형식이 맞지 않다');
  if (!/^[A-Za-z0-9.\-]+:\d{1,5}$/.test(obj.endpoint)) throw new Error('초대 코드의 접속 주소 형식이 맞지 않다');
  if (!/^[A-Za-z0-9]{8,64}$/.test(obj.apiKey)) throw new Error('초대 코드의 API 키 형식이 맞지 않다');
  return obj;
}

async function apiKey() {
  const s = await readState();
  return s ? s.apiKey : null;
}

module.exports = {
  TUNNEL, PORT, SUBNET,
  installed, version, info, status, publicIp, localIps,
  ensureState, addPeer, removePeer, setEndpoint, setServe, serve, peerConf, apiKey, rotateApiKey,
  invite, parseInvite, INVITE_PREFIX,
  up, down, allowFirewall, firewallStatus, listenStatus, blockingRules, disableBlockingRules,
  serverConf, clientConf, nextAddress,
  confPath, statePath
};
