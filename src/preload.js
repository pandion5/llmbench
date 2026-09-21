'use strict';
// CONTRACT.md의 window.api를 그대로 노출한다.

const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  check: {
    run: () => call('check:run')
  },
  config: {
    get: () => call('config:get'),
    set: (partial) => call('config:set', partial),
    export: () => call('config:export'),
    import: () => call('config:import')
  },
  install: {
    start: (opts) => call('install:start', opts),
    cancel: () => call('install:cancel'),
    status: () => call('install:status')
  },
  server: {
    start: () => call('server:start'),
    stop: () => call('server:stop'),
    status: () => call('server:status'),
    logs: () => call('server:logs'),
    saveLogs: () => call('server:saveLogs')
  },
  harness: {
    list: () => call('harness:list'),
    install: (id) => call('harness:install', id),
    launch: (id, opts) => call('harness:launch', id, opts)
  },
  monitor: {
    snapshot: () => call('monitor:snapshot')
  },
  bench: {
    run: (opts) => call('bench:run', opts),
    cancel: () => call('bench:cancel'),
    export: () => call('bench:export')
  },
  diag: {
    copy: () => call('diag:copy'),
    share: () => call('diag:share')
  },
  wg: {
    info: () => call('wg:info'),
    publicIp: () => call('wg:publicIp'),
    localIps: () => call('wg:localIps'),
    unblock: () => call('wg:unblock'),
    up: () => call('wg:up'),
    down: () => call('wg:down'),
    addPeer: (name) => call('wg:addPeer', name),
    removePeer: (name) => call('wg:removePeer', name),
    setEndpoint: (ep) => call('wg:setEndpoint', ep),
    setServe: (on) => call('wg:setServe', on),
    rotateApiKey: () => call('wg:rotateApiKey'),
    invite: (name) => call('wg:invite', name),
    peerConf: (name) => call('wg:peerConf', name),
    savePeerConf: (name) => call('wg:savePeerConf', name)
  },
  term: {
    start: (id, opts) => call('term:start', id, opts),
    write: (id, data) => call('term:write', id, data),
    resize: (id, cols, rows) => call('term:resize', id, cols, rows),
    kill: (id) => call('term:kill', id),
    snapshot: (id) => call('term:snapshot', id)
  },
  shell: {
    openPath: (p) => call('shell:openPath', p)
  },
  app: {
    isAdmin: () => call('app:isAdmin'),
    version: () => call('app:version'),
    copy: (text) => call('app:copy', text),
    paste: () => call('app:paste')
  },
  update: {
    check: () => call('update:check'),
    apply: () => call('update:apply')
  },
  // 이벤트 구독. 반환값을 호출하면 해제된다.
  on: (channel, cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
