'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sys = require('./sys');
const config = require('./config');
const install = require('./install');
const server = require('./server');
const proxy = require('./proxy');
const bench = require('./bench');
const harness = require('./harness');
const update = require('./update');
const terminal = require('./terminal');
const wireguard = require('./wireguard');

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
let monitorTimer = null;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// 관리자 권한으로 다시 띄운다. 이미 관리자면 그대로 진행.
// 검증할 때는 LLMBENCH_NO_ELEVATE=1로 건너뛴다.
async function ensureAdmin() {
  if (process.env.LLMBENCH_NO_ELEVATE === '1') return true;
  if (await sys.isAdmin()) return true;

  // 개발 모드에서는 electron.exe에 앱 폴더를 넘겨야 같은 앱이 다시 뜬다
  const args = app.isPackaged ? process.argv.slice(1) : [app.getAppPath(), ...process.argv.slice(2)];
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const cmd =
    `Start-Process -FilePath ${quote(process.execPath)} -Verb RunAs` +
    (args.length ? ` -ArgumentList ${args.map(quote).join(',')}` : '');
  // Electron 자식 프로세스는 Job 객체에 묶여 부모가 끝나면 같이 죽는다.
  // Start-Process가 끝날 때까지 기다린 뒤 종료해야 승격된 인스턴스가 살아남는다.
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (e) {
      resolve(-1);
      return;
    }
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c));
  });
  if (code !== 0) {
    // 승격에 실패해도 앱은 띄운다. 점검 화면에 관리자 권한 없음으로 표시된다.
    console.error('관리자 승격 실패: powershell 종료코드', code);
    return true;
  }
  app.quit();
  return false;
}

// registerIpc 안에서 만든 함수를 부팅 때도 쓴다.
let startProxyAtBoot = async () => {};
// 벤치 진행 글과 마지막 오류. 클라이언트가 터널 너머에서 읽는다.
let benchProgress = null;
let benchError = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'llmbench',
    backgroundColor: '#161616',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload는 contextBridge와 ipcRenderer만 쓰므로 샌드박스를 켤 수 있다
      sandbox: true
    }
  });
  // renderer는 별도로 만들어진다. 아직 없으면 빈 페이지로 띄운다.
  if (fs.existsSync(INDEX_HTML)) win.loadFile(INDEX_HTML);
  else win.loadURL('about:blank');
  return win;
}

// 기록 파일은 앱 폴더 아래 logs/<sub>에 둔다. 여러 PC 결과를 한곳에 모으려고 앱 폴더가 먼저다.
// 패키징 후 asar 안이거나 쓰기 권한이 없으면 userData/logs/<sub>로 옮겨 쓴다.
// writer(dir)가 폴더를 받아 파일을 쓰고 경로를 돌려준다.
async function withLogsDir(sub, writer) {
  const primary = path.join(app.getAppPath(), 'logs', sub);
  try {
    await fsp.mkdir(primary, { recursive: true });
    return await writer(primary);
  } catch (e) {
    const fallback = path.join(app.getPath('userData'), 'logs', sub);
    console.error(`${primary}에 쓰지 못함(${e.message}). ${fallback}로 대신 저장한다.`);
    await fsp.mkdir(fallback, { recursive: true });
    return writer(fallback);
  }
}

// 점검 결과를 PC 이름으로 저장한다. 같은 PC는 덮어쓴다.
async function writeSpecLog(dir, report, cfg) {
  const file = path.join(dir, `${os.hostname()}-spec.json`);
  // 저장한 파일 안의 report도 돌려주는 값과 같게 맞춘다
  report.specLogPath = file;
  await fsp.writeFile(
    file,
    JSON.stringify({ ts: Date.now(), computer: os.hostname(), report, config: cfg }, null, 2),
    'utf8'
  );
  return file;
}

function saveSpecLog(report, cfg) {
  return withLogsDir('spec-logs', (dir) => writeSpecLog(dir, report, cfg));
}

// 진단 묶음. 설정, 하드웨어, models.ini, bin 구성, 모델 파일 목록, 서버 로그를 한 텍스트로 만든다.
// 문제가 생겼을 때 이 한 덩이만 넘기면 상태를 알 수 있게 하는 것이 목적이다.
const PASTE_URL = 'https://paste.rs';

async function readOr(file, fallback) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    return `${fallback}: ${e.message}`;
  }
}

async function listModelFiles(installDir) {
  const root = path.join(installDir, 'models');
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const st = await fsp.stat(full).catch(() => null);
        const gb = st ? (st.size / 1024 ** 3).toFixed(2) : '?';
        out.push(`${path.relative(root, full)}  ${gb}GB`);
      }
    }
  };
  await walk(root, 0);
  return out.length ? out : ['모델 폴더가 비어 있거나 없음'];
}

// 키 같은 값을 그대로 내보내지 않는다.
function mask(v) {
  if (!v) return null;
  return `${String(v).slice(0, 6)}... (${String(v).length}자)`;
}

async function buildDiag() {
  const cfg = await config.get();
  const lines = [
    `llmbench ${app.getVersion()}  ${os.hostname()}  ${new Date().toISOString()}`,
    '',
    '[설정]',
    JSON.stringify(cfg, null, 2),
    '',
    '[하드웨어]'
  ];
  try {
    lines.push(JSON.stringify(await sys.getHwInfo(cfg.installDir), null, 2));
  } catch (e) {
    lines.push(`조회 실패: ${e.message}`);
  }

  lines.push('', '[models.ini]', await readOr(path.join(cfg.installDir, 'models.ini'), '읽지 못함'));

  // 키가 들어간 값은 앞 6자만 남긴다. 진단은 외부에 올라갈 수 있다.
  lines.push('', '[WireGuard]');
  try {
    const wi = await wireguard.info();
    lines.push(
      JSON.stringify(
        {
          installed: wi.installed,
          version: wi.version,
          configured: wi.configured,
          address: wi.address,
          port: wi.port,
          endpoint: wi.endpoint,
          serverPublicKey: mask(wi.serverPublicKey),
          apiKey: mask(wi.apiKey),
          peers: wi.peers.map((p) => ({ name: p.name, address: p.address, publicKey: mask(p.publicKey) })),
          running: wi.status.running,
          connected: wi.status.peers.map((p) => ({ name: p.name, lastHandshake: p.lastHandshake }))
        },
        null,
        2
      )
    );
  } catch (e) {
    lines.push(`조회 실패: ${e.message}`);
  }

  lines.push('', '[bin]');
  const bin = path.join(cfg.installDir, 'bin');
  lines.push(await readOr(path.join(bin, 'llmbench-build.json'), '빌드 정보 없음'));
  const names = await fsp.readdir(bin).catch(() => []);
  lines.push(
    `파일 ${names.length}개` +
      `, llama-server.exe ${names.includes('llama-server.exe') ? '있음' : '없음'}` +
      `, llama-bench.exe ${names.includes('llama-bench.exe') ? '있음' : '없음'}` +
      `, cudart64_12.dll ${names.includes('cudart64_12.dll') ? '있음' : '없음'}` +
      `, ggml-cuda.dll ${names.includes('ggml-cuda.dll') ? '있음' : '없음'}`
  );

  lines.push('', '[모델 파일]', ...(await listModelFiles(cfg.installDir)));
  lines.push('', '[서버 상태]', JSON.stringify(server.status(), null, 2));
  lines.push('', '[서버 로그]', ...server.logs());
  return lines.join('\r\n');
}

function registerIpc() {
  ipcMain.handle('check:run', async () => {
    const cfg = await config.get();
    const report = await sys.runCheck(cfg);
    try {
      report.specLogPath = await saveSpecLog(report, cfg);
    } catch (e) {
      // 두 경로 모두 실패. 점검 결과는 돌려주되 사유를 남긴다.
      report.specLogPath = '';
      console.error('점검 결과를 저장하지 못함(앱 폴더, userData 모두 실패):', e.message);
    }
    return report;
  });

  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (_e, partial) => config.set(partial));

  // 설정 파일 내보내기·가져오기. 다른 PC에 같은 설정을 옮길 때 쓴다.
  // 가져온 값은 config.set을 거치므로 잘못된 값은 걸러진다.
  ipcMain.handle('config:export', async (e) => {
    const cfg = await config.get();
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: '설정 내보내기',
      defaultPath: path.join(app.getPath('documents'), `llmbench-config-${os.hostname()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { path: null, error: null };
    await fsp.writeFile(r.filePath, JSON.stringify(cfg, null, 2), 'utf8');
    return { path: r.filePath, error: null };
  });
  ipcMain.handle('config:import', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: '설정 가져오기',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { config: null, path: null, error: null };
    try {
      const raw = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('JSON 객체가 아님');
      const cfg = await config.set(raw);
      return { config: cfg, path: r.filePaths[0], error: null };
    } catch (err) {
      return { config: null, path: r.filePaths[0], error: err.message };
    }
  });

  ipcMain.handle('install:start', async (_e, opts) => {
    const cfg = await config.get();
    const report = await sys.runCheck(cfg);
    // 승격을 건너뛰고 띄운 경우에만 관리자 항목을 무시한다
    const g = install.gate(report, opts, process.env.LLMBENCH_NO_ELEVATE === '1');
    if (g.blocked) return { started: false, reason: g.reason };
    const r = install.start(cfg);
    return { started: r.started, reason: r.started ? null : '설치가 이미 돌고 있음' };
  });
  ipcMain.handle('install:cancel', () => install.cancel());
  ipcMain.handle('install:status', () => install.status());

  // llama-server는 안쪽 포트에서만 듣고, 바깥에서 오는 요청은 프록시가 받는다.
  // 프록시가 누가 무엇을 물었는지 남기고 줄을 세운다.
  async function startProxy() {
    const cfg = await config.get();
    return proxy.start({
      upstream: server.BASE_URL,
      apiKey: await wireguard.apiKey(),
      logDir: path.join(cfg.installDir, 'logs', 'chat'),
      blockModels: ['qwen36'],
      peers: (await wireguard.info()).peers,
      limit: Math.max(1, Number(cfg.slots) || 1),
      share: await wireguard.serve(),
      serverInfo: async () => ({ status: await server.refresh(), logs: server.logs() }),
      control: {
        startServer: async (from) => {
          console.log(`[제어] ${from.who}(${from.address})가 서버 시작을 요청`);
          return startServer();
        },
        stopServer: async (from) => {
          console.log(`[제어] ${from.who}(${from.address})가 서버 중지를 요청`);
          return server.stop();
        },
        updateCheck: () => update.check(),
        updateApply: async (from) => {
          console.log(`[제어] ${from.who}(${from.address})가 앱 업데이트를 요청`);
          return update.apply();
        },
        // 벤치는 몇 분 걸린다. 시작만 시키고 바로 답한다. 진행은 /llmbench/bench로 본다.
        benchRun: async (from, body) => serialize(async () => {
          if (bench.busy()) throw new Error('벤치가 이미 돌고 있다');
          const opts = { model: (body && body.model) || 'qwen38', mode: (body && body.mode) || 'ncmoe' };
          console.log(`[제어] ${from.who}(${from.address})가 벤치 시작을 요청 (${opts.model}, ${opts.mode})`);
          benchError = null;
          runBench(opts).catch((e) => { benchError = e.message; });
          return { ok: true, started: opts };
        }),
        // CPU 전문가 층 벤치의 가장 빠른 값을 설정에 넣고 models.ini를 다시 쓴다.
        // 서버가 켜져 있으면 다음에 켤 때 반영된다. 여기서 재기동은 안 한다.
        benchApply: async (from) => {
          const last = bench.last();
          if (!last || last.mode !== 'ncmoe' || !last.ncmoe) throw new Error('적용할 CPU 전문가 층 결과가 없다');
          if (last.model !== 'qwen38') throw new Error('3.6의 층 수는 설정에 없다. 3.8만 적용된다');
          const v = last.ncmoe.best.ncmoe;
          console.log(`[제어] ${from.who}(${from.address})가 CPU 전문가 층 ${v} 적용을 요청`);
          const cfg = await config.set({ ncmoe38: v });
          await install.stepPreset(cfg);
          return { ok: true, ncmoe38: v };
        },
        benchCancel: async (from) => {
          console.log(`[제어] ${from.who}(${from.address})가 벤치 중지를 요청`);
          bench.cancel();
          return { ok: true };
        }
      },
      benchInfo: async () => ({
        busy: bench.busy(),
        progress: benchProgress,
        error: benchError,
        last: bench.last()
      })
    });
  }

  // llama-server를 띄운다. 프록시는 이미 떠 있으니 슬롯 수만 맞춘다.
  // 서버 시작과 벤치 시작은 같은 잠금을 거친다. 둘이 겹치면 GPU를 같이 써서 둘 다 망가진다.
  let transition = Promise.resolve();
  function serialize(fn) {
    const next = transition.then(fn, fn);
    transition = next.catch(() => {});
    return next;
  }

  async function startServer() {
    return serialize(async () => {
      if (bench.busy()) throw new Error('벤치가 돌고 있다. 끝난 뒤 켠다.');
      const cfg = await config.get();
      const apiKey = await wireguard.apiKey();
      // 기존 models.ini에 시작 때 올릴 모델이 둘이면 서버가 뜨지 않는다. 다시 쓴다.
      await migratePreset(cfg);
      if (bench.busy()) throw new Error('벤치가 돌고 있다. 끝난 뒤 켠다.');
      const r = await server.start(cfg, { apiKey, onReady: () => warmCache(cfg, apiKey) });
      proxy.setLimit(Math.max(1, Number(cfg.slots) || 1));
      return r;
    });
  }

  // 예전 버전이 만든 models.ini는 3.6도 load-on-startup = true일 수 있다. --models-max 1과 충돌한다.
  async function migratePreset(cfg) {
    const file = path.join(cfg.installDir, 'models.ini');
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (e) {
      return;
    }
    const n = (text.match(/^load-on-startup\s*=\s*true/gm) || []).length;
    if (n <= 1) return;
    console.log(`[프리셋] 시작 때 올릴 모델이 ${n}개라 models.ini를 다시 쓴다`);
    await install.stepPreset(cfg);
  }

  // 서버가 뜬 직후 보관해 둔 시스템 프롬프트를 모델별로 한 번 보낸다.
  // 답은 1토큰만 받는다. 이걸로 프롬프트 캐시가 채워져 첫 사람이 바로 답을 받는다.
  // 3.6은 시작할 때 올리도록 설정한 경우에만 한다. 아니면 20GB를 괜히 올린다.
  let warmedDay = '';
  async function warmCache(cfg, apiKey) {
    warmedDay = new Date().toDateString();
    const list = await proxy.warmPrompts();
    const me = { at: '', who: '이 PC', address: '127.0.0.1' };
    for (const w of list) {
      // 3.6은 예열하지 않는다. 한 번에 한 모델만 올리는 서버라 3.8이 내려간다.
      if (w.model !== 'qwen38') continue;
      const t0 = Date.now();
      const ev = Object.assign({}, me, { at: new Date().toISOString(), action: `캐시 예열 ${w.model}`, ok: true, error: null });
      // 어느 하네스 것인지 알아볼 수 있게 시스템 프롬프트 첫 단어 몇 개를 붙인다.
      const first = w.messages && w.messages[0] && typeof w.messages[0].content === 'string' ? w.messages[0].content : '';
      if (first) ev.action += ` "${first.replace(/\s+/g, ' ').slice(0, 24)}…"`;
      try {
        const res = await fetch(`${server.BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // 저장해 둔 요청 필드를 그대로 싣고 답 길이와 스트리밍만 바꾼다. 여기에 옵션을 더 붙이면
          // 프롬프트 첫 줄이 바뀌어(생각 끄기 옵션이 그랬다) 캐시를 하나도 못 탄다.
          body: JSON.stringify(Object.assign({}, w, { at: undefined, lead: undefined, max_tokens: 1, stream: false }))
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const n = json.timings ? json.timings.prompt_n : 0;
        ev.action += ` (${n}토큰, ${Math.round((Date.now() - t0) / 1000)}초)`;
      } catch (e) {
        ev.ok = false;
        ev.error = e.message;
      }
      console.log(`[예열] ${ev.action}${ev.ok ? '' : ' 실패: ' + ev.error}`);
      proxy.recordEvent(ev);
      if (ev.ok && typeof w.lead === 'string' && w.lead) await warmLead(w, apiKey, first);
    }
  }

  // 질문 앞 안내문 끝에 체크포인트를 하나 더 만든다. 새 세션 첫 질문이 안내문 1천 토큰을 다시 읽지 않고
  // 질문만 읽는다. 안내문 뒤에 "A"와 "B"를 붙여 렌더링해 토큰으로 바꾸고, 갈라지는 곳까지를 보낸다.
  // 바로 앞 예열 상태에서 이어 읽으니 안내문 길이만큼만 든다. 실패해도 앞 예열은 그대로 쓴다.
  async function warmLead(w, apiKey, first) {
    const t0 = Date.now();
    const ev = { at: new Date().toISOString(), who: '이 PC', address: '127.0.0.1', action: `캐시 예열 ${w.model} 안내문`, ok: true, error: null };
    if (first) ev.action += ` "${first.replace(/\s+/g, ' ').slice(0, 24)}…"`;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    const post = async (p, body) => {
      const res = await fetch(`${server.BASE_URL}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${p} HTTP ${res.status}`);
      return res.json();
    };
    const tokens = async (suffix) => {
      const body = Object.assign({}, w, { at: undefined, lead: undefined, messages: [w.messages[0], { role: 'user', content: w.lead + suffix }] });
      const { prompt } = await post('/apply-template', body);
      return (await post('/tokenize', { model: w.model, content: prompt, add_special: true })).tokens;
    };
    try {
      const body = proxy.leadWarmBody(w.model, await tokens('A'), await tokens('B'));
      if (!body) throw new Error('안내문 끝을 찾지 못했다');
      const json = await post('/completion', body);
      const n = json.timings ? json.timings.prompt_n : 0;
      ev.action += ` (${n}토큰, ${Math.round((Date.now() - t0) / 1000)}초)`;
    } catch (e) {
      ev.ok = false;
      ev.error = e.message;
    }
    console.log(`[예열] ${ev.action}${ev.ok ? '' : ' 실패: ' + ev.error}`);
    proxy.recordEvent(ev);
  }

  // 예열 파일은 오늘 날짜로 바꿔 보내지만 서버가 며칠 켜져 있으면 캐시에는 예열한 날의 날짜가 남는다.
  // 날짜가 바뀐 뒤 요청이 없을 때 한 번 더 예열한다. 3.6이 올라가 있으면 예열이 3.8을 다시 올리니 기다린다.
  setInterval(async () => {
    if (!warmedDay || warmedDay === new Date().toDateString()) return;
    if (bench.busy() || server.status().state !== 'ready') return;
    const p = proxy.status();
    if (p.running.length || p.waiting.length) return;
    if (!(await server.fetchModels()).some((m) => m.id === 'qwen38' && m.loaded)) return;
    wireguard.apiKey().then((k) => warmCache(null, k)).catch((e) => console.error('날짜 바뀐 뒤 예열 실패:', e.message));
  }, 60 * 1000);

  ipcMain.handle('server:start', () => startServer());

  startProxyAtBoot = async () => {
    await startProxy();
    const cfg = await config.get();
    if (cfg.autoStart !== false) {
      startServer().catch((e) => console.error('서버 자동 시작 실패:', e.message));
    }
  };

  ipcMain.handle('proxy:status', () => proxy.status());
  ipcMain.handle('proxy:restart', () => startProxy());
  ipcMain.handle('proxy:logDays', () => proxy.logDays());
  ipcMain.handle('proxy:log', (_e, day) => proxy.readLog(day));

  // 프록시는 내리지 않는다. 서버가 꺼져 있어도 클라이언트가 상태를 보고 켜라고 할 수 있어야 한다.
  ipcMain.handle('server:stop', () => server.stop());
  ipcMain.handle('server:status', () => server.refresh());
  ipcMain.handle('server:logs', () => server.logs());
  ipcMain.handle('server:saveLogs', () =>
    withLogsDir('server-logs', async (dir) => {
      const file = path.join(dir, `${os.hostname()}-server-${Date.now()}.log`);
      await fsp.writeFile(file, server.logs().join('\r\n'), 'utf8');
      return { path: file };
    })
  );

  ipcMain.handle('diag:copy', async () => {
    const text = await buildDiag();
    clipboard.writeText(text);
    return { chars: text.length };
  });
  // 인터넷에 공개로 올라간다. 화면에서 확인을 받은 뒤에만 부른다.
  ipcMain.handle('diag:share', async () => {
    const text = await buildDiag();
    const res = await fetch(PASTE_URL, { method: 'POST', body: text });
    if (!res.ok) throw new Error(`업로드 실패 HTTP ${res.status}`);
    const url = (await res.text()).trim();
    clipboard.writeText(url);
    return { url, chars: text.length };
  });

  ipcMain.handle('monitor:snapshot', async () => sys.getSnapshot((await config.get()).installDir));

  withLogsDir('bench-logs', (dir) => bench.restoreLast(dir)).catch((e) => console.error(`벤치 결과 복원 실패: ${e.message}`));

  // 화면에서도, 클라이언트가 터널 너머에서도 같은 길로 벤치를 돌린다.
  async function runBench(opts) {
    const res = await bench.run(opts, await config.get());
    // 결과는 끝나는 대로 남긴다. 저장 버튼을 안 눌러 결과가 사라지는 일이 있었다.
    try {
      const saved = await withLogsDir('bench-logs', (dir) => bench.exportLast(dir));
      res.savedTo = saved.path;
    } catch (e) {
      res.saveError = e.message;
    }
    return res;
  }

  ipcMain.handle('bench:run', (_e, opts) => runBench(opts));
  ipcMain.handle('bench:cancel', () => bench.cancel());
  ipcMain.handle('bench:export', () => withLogsDir('bench-logs', (dir) => bench.exportLast(dir)));

  ipcMain.handle('wg:info', () => wireguard.info());
  ipcMain.handle('wg:publicIp', () => wireguard.publicIp());
  ipcMain.handle('wg:localIps', () => wireguard.localIps());
  ipcMain.handle('wg:unblock', () => wireguard.disableBlockingRules());
  ipcMain.handle('wg:up', () => wireguard.up());
  ipcMain.handle('wg:down', () => wireguard.down());
  ipcMain.handle('wg:addPeer', (_e, name) => wireguard.addPeer(name));
  ipcMain.handle('wg:removePeer', (_e, name) => wireguard.removePeer(name));
  ipcMain.handle('wg:setEndpoint', (_e, ep) => wireguard.setEndpoint(ep));
  ipcMain.handle('wg:setServe', (_e, on) => wireguard.setServe(on));
  ipcMain.handle('wg:rotateApiKey', () => wireguard.rotateApiKey());
  ipcMain.handle('wg:invite', (_e, name) => wireguard.invite(name));
  ipcMain.handle('wg:peerConf', (_e, name) => wireguard.peerConf(name));
  // 클라이언트 설정에는 개인 키가 들어 있다. 파일로 내보낼 때만 디스크에 쓴다.
  ipcMain.handle('wg:savePeerConf', async (_e, name) => {
    const text = await wireguard.peerConf(name);
    const r = await dialog.showSaveDialog({
      title: 'WireGuard 설정 저장',
      defaultPath: `${name}.conf`,
      filters: [{ name: 'WireGuard', extensions: ['conf'] }]
    });
    if (r.canceled || !r.filePath) return { saved: false };
    await fsp.writeFile(r.filePath, text, 'utf8');
    return { saved: true, path: r.filePath };
  });

  ipcMain.handle('term:start', (_e, id, opts) => terminal.start(id, opts));
  ipcMain.handle('term:write', (_e, id, data) => terminal.write(id, data));
  ipcMain.handle('term:resize', (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  ipcMain.handle('term:kill', (_e, id) => terminal.kill(id));
  ipcMain.handle('term:snapshot', (_e, id) => terminal.snapshot(id));

  ipcMain.handle('harness:list', () => harness.list());
  ipcMain.handle('harness:install', (_e, id) => harness.install(id));
  ipcMain.handle('harness:launch', async (_e, id, opts) => harness.launch(id, opts, await config.get()));

  ipcMain.handle('update:check', () => update.check());
  ipcMain.handle('update:apply', () => update.apply());

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('app:isAdmin', () => sys.isAdmin());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });
  ipcMain.handle('app:paste', () => clipboard.readText());

  install.onProgress((s) => broadcast('install:progress', s));
  server.onStatus((s) => broadcast('server:status', s));
  proxy.onEvent((s) => broadcast('proxy:status', s));
  bench.onProgress((p) => {
    benchProgress = p;
    broadcast('bench:progress', p);
  });
  harness.onLog((line) => broadcast('harness:log', line));
  update.onProgress((p) => broadcast('update:progress', p));
  terminal.onEvent((e) => broadcast('term:event', e));
}

// 1초마다 스냅샷을 보낸다. nvidia-smi 호출이 1초를 넘기면 그 회차는 건너뛴다.
function startMonitor() {
  let busy = false;
  monitorTimer = setInterval(async () => {
    if (busy || BrowserWindow.getAllWindows().length === 0) return;
    busy = true;
    try {
      const cfg = await config.get();
      broadcast('monitor:tick', await sys.getSnapshot(cfg.installDir));
    } catch {
      // 한 회차 실패는 넘긴다
    } finally {
      busy = false;
    }
  }, 1000);
}

// 콘솔 창 없이 띄우는 런처. 구버전 업데이트 배치는 이 파일을 복사하지 않으므로 없으면 앱이 만든다.
async function ensureLauncher() {
  if (app.isPackaged) return;
  const file = path.join(app.getAppPath(), 'llmbench.vbs');
  if (fs.existsSync(file)) return;
  try {
    await fsp.copyFile(path.join(__dirname, 'launcher.vbs'), file);
  } catch (e) {
    console.error('llmbench.vbs를 만들지 못함:', e.message);
  }
}

app.whenReady().then(async () => {
  if (!(await ensureAdmin())) return;
  await ensureLauncher();
  registerIpc();
  createWindow();
  startMonitor();

  // 프록시는 앱이 켜져 있는 동안 늘 떠 있다. 설정에 따라 llama-server도 바로 올린다.
  try {
    await startProxyAtBoot();
  } catch (e) {
    console.error('프록시를 못 띄웠다:', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (monitorTimer) clearInterval(monitorTimer);
  install.cancel();
  terminal.killAll();
  proxy.stop();
  server.stop();
});
