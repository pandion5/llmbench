'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sys = require('./sys');
const config = require('./config');
const install = require('./install');
const server = require('./server');
const bench = require('./bench');
const harness = require('./harness');
const update = require('./update');

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

  ipcMain.handle('server:start', async () => server.start(await config.get()));
  ipcMain.handle('server:stop', () => server.stop());
  ipcMain.handle('server:status', () => server.refresh());

  ipcMain.handle('monitor:snapshot', async () => sys.getSnapshot((await config.get()).installDir));

  ipcMain.handle('bench:run', async (_e, opts) => bench.run(opts, await config.get()));
  ipcMain.handle('bench:cancel', () => bench.cancel());
  ipcMain.handle('bench:export', () => withLogsDir('bench-logs', (dir) => bench.exportLast(dir)));

  ipcMain.handle('harness:list', () => harness.list());
  ipcMain.handle('harness:install', (_e, id) => harness.install(id));
  ipcMain.handle('harness:launch', async (_e, id, opts) => harness.launch(id, opts, await config.get()));

  ipcMain.handle('update:check', () => update.check());
  ipcMain.handle('update:apply', () => update.apply());

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('app:isAdmin', () => sys.isAdmin());
  ipcMain.handle('app:version', () => app.getVersion());

  install.onProgress((s) => broadcast('install:progress', s));
  server.onStatus((s) => broadcast('server:status', s));
  bench.onProgress((p) => broadcast('bench:progress', p));
  harness.onLog((line) => broadcast('harness:log', line));
  update.onProgress((p) => broadcast('update:progress', p));
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (monitorTimer) clearInterval(monitorTimer);
  install.cancel();
  server.stop();
});
