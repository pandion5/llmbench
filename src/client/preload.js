'use strict';
// 클라이언트 화면에 노출하는 창구.

const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  conn: {
    status: () => call('conn:status'),
    apply: (code) => call('conn:apply', code),
    up: () => call('conn:up'),
    down: () => call('conn:down'),
    forget: () => call('conn:forget'),
    health: () => call('conn:health'),
    models: () => call('conn:models')
  },
  chat: {
    send: (messages, opts) => call('chat:send', messages, opts),
    cancel: () => call('chat:cancel')
  },
  harness: {
    list: () => call('harness:list'),
    install: (id) => call('harness:install', id),
    launch: (id, opts) => call('harness:launch', id, opts)
  },
  term: {
    start: (id, opts) => call('term:start', id, opts),
    write: (id, data) => call('term:write', id, data),
    resize: (id, cols, rows) => call('term:resize', id, cols, rows),
    kill: (id) => call('term:kill', id),
    snapshot: (id) => call('term:snapshot', id)
  },
  update: {
    check: () => call('update:check'),
    apply: () => call('update:apply')
  },
  app: {
    version: () => call('app:version'),
    copy: (text) => call('app:copy', text),
    paste: () => call('app:paste'),
    workspace: () => call('app:workspace')
  },
  shell: {
    openPath: (p) => call('shell:openPath', p),
    pickDir: () => call('shell:pickDir')
  },
  on: (channel, cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
