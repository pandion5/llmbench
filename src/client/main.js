'use strict';
// 클라이언트 앱. 초대 코드로 터널을 올리고, 서버의 llama-server에 대화를 보낸다.
// 모델 설치나 벤치마크는 없다. 그쪽은 서버 앱이 맡는다.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');

const tunnel = require('./tunnel');
const chat = require('./chat');
const terminal = require('../terminal');
const harness = require('../harness');
const update = require('../update');

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');

// 하네스 기본 작업 폴더. 실행 파일이 있는 자리에 workspace를 만든다.
// 안 정하면 하네스가 홈에서 시작해 사용자 폴더를 어지른다.
function workspaceDir() {
  const base = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
  return path.join(base, 'workspace');
}

function ensureWorkspace() {
  const dir = workspaceDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    // 쓸 수 없는 자리에 깔린 경우다. 화면에서 직접 고르게 둔다.
    return null;
  }
}
let statusTimer = null;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.loadFile(INDEX_HTML);
  return win;
}

function registerIpc() {
  ipcMain.handle('conn:status', async () => {
    const st = await tunnel.status();
    const t = await tunnel.target();
    return { ...st, target: t ? { baseUrl: t.baseUrl, name: t.name } : null };
  });
  ipcMain.handle('conn:apply', (_e, code) => tunnel.applyInvite(code));
  ipcMain.handle('conn:up', () => tunnel.up());
  ipcMain.handle('conn:down', () => tunnel.down());
  ipcMain.handle('conn:forget', () => tunnel.forget());
  ipcMain.handle('conn:health', async () => chat.health(await tunnel.target()));
  ipcMain.handle('conn:models', async () => chat.models(await tunnel.target()));

  ipcMain.handle('chat:send', async (_e, messages, opts) => chat.send(await tunnel.target(), messages, opts));
  ipcMain.handle('chat:cancel', () => chat.cancel());

  ipcMain.handle('term:start', (_e, id, opts) => terminal.start(id, opts));
  ipcMain.handle('term:write', (_e, id, data) => terminal.write(id, data));
  ipcMain.handle('term:resize', (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  ipcMain.handle('term:kill', (_e, id) => terminal.kill(id));
  ipcMain.handle('term:snapshot', (_e, id) => terminal.snapshot(id));

  ipcMain.handle('harness:list', () => harness.list());
  ipcMain.handle('harness:install', (_e, id) => harness.install(id));
  ipcMain.handle('harness:launch', async (_e, id, opts) => {
    const t = await tunnel.target();
    if (!t) return { ok: false, error: '서버에 연결돼 있지 않다' };
    // 화면에서 폴더를 비워 보냈으면 기본 workspace로 채운다.
    const withDir = Object.assign({}, opts);
    if (!withDir.workDir) withDir.workDir = ensureWorkspace() || '';
    return harness.launchRemote(id, withDir, t);
  });

  ipcMain.handle('usage:status', () => tunnel.serverStatus());
  ipcMain.handle('usage:days', () => tunnel.serverLogDays());
  ipcMain.handle('usage:log', (_e, day) => tunnel.serverLog(day));
  ipcMain.handle('update:check', () => update.check());
  ipcMain.handle('update:apply', () => update.apply());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });
  ipcMain.handle('app:paste', () => clipboard.readText());
  ipcMain.handle('app:workspace', () => ensureWorkspace());
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  chat.onEvent((e) => broadcast('chat:event', e));
  terminal.onEvent((e) => broadcast('term:event', e));
  harness.onLog((line) => broadcast('harness:log', line));
  update.onProgress((p) => broadcast('update:progress', p));
}

// 연결 상태를 3초마다 알린다. 터널이 끊기면 화면이 바로 안다.
function startStatusLoop() {
  let busy = false;
  statusTimer = setInterval(async () => {
    if (busy || BrowserWindow.getAllWindows().length === 0) return;
    busy = true;
    try {
      const st = await tunnel.status();
      const t = await tunnel.target();
      broadcast('conn:event', { ...st, target: t ? { baseUrl: t.baseUrl, name: t.name } : null });
    } catch {
      // 조회 실패는 다음 회차에 다시 본다
    } finally {
      busy = false;
    }
  }, 3000);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startStatusLoop();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
  chat.cancel();
  terminal.killAll();
});
