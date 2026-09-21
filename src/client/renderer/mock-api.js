'use strict';
// 브라우저에서 화면만 볼 때 쓰는 가짜 API. 실제 앱에서는 preload가 window.api를 넣는다.

(function () {
  if (window.api) return;

  var listeners = {};
  function emit(ch, payload) {
    (listeners[ch] || []).forEach(function (cb) { cb(payload); });
  }

  var conn = {
    installed: true,
    configured: true,
    running: true,
    endpoint: '218.144.243.86:51820',
    lastHandshake: new Date().toISOString(),
    rxBytes: 2048,
    txBytes: 1024,
    target: { baseUrl: 'http://10.66.0.1:8080', name: '노트북' }
  };

  window.api = {
    conn: {
      status: function () { return Promise.resolve(conn); },
      apply: function () { conn.configured = true; return Promise.resolve({ name: '노트북', serverAddress: '10.66.0.1', endpoint: '218.144.243.86:51820' }); },
      up: function () { conn.running = true; return Promise.resolve({ ok: true }); },
      down: function () { conn.running = false; return Promise.resolve({ ok: true }); },
      forget: function () { conn.configured = false; conn.running = false; return Promise.resolve({ ok: true }); },
      health: function () { return Promise.resolve(true); },
      models: function () { return Promise.resolve([{ id: 'qwen38', loaded: true }, { id: 'qwen36', loaded: false }]); }
    },
    chat: {
      send: function (messages) {
        var asked = messages[messages.length - 1].content;
        // 생각하는 모델을 흉내 낸다. 사고 과정이 먼저 오고 그다음에 답이 온다.
        var think = '물어본 것은 "' + asked + '"다. 무엇을 묻는지 먼저 정리한다. ' +
          '답에 들어갈 것을 추린다. 길이는 짧게 잡는다. 이제 답을 적는다.';
        var answer = '받은 말: ' + asked + '. 이건 가짜 응답이다.';
        var i = 0;
        var j = 0;
        var timer = setInterval(function () {
          if (j < think.length) {
            emit('chat:event', { type: 'reasoning', text: think.slice(j, j + 4) });
            j += 4;
            return;
          }
          if (i >= answer.length) {
            clearInterval(timer);
            emit('chat:event', { type: 'done', text: answer, stat: { seconds: 2.1, tokens: 42, tokPerSec: 20.3, waitSeconds: 0.4 } });
            return;
          }
          emit('chat:event', { type: 'delta', text: answer.slice(i, i + 3) });
          i += 3;
        }, 40);
        return Promise.resolve({ text: answer });
      },
      cancel: function () { return Promise.resolve({ ok: true }); }
    },
    harness: {
      list: function () {
        return Promise.resolve([
          { id: 'qwen-code', name: 'Qwen Code', note: 'Qwen3-Coder용 CLI', installed: true, version: '0.2.3' },
          { id: 'opencode', name: 'OpenCode', note: '터미널 TUI', installed: false, version: null }
        ]);
      },
      install: function () { return Promise.resolve({ ok: true }); },
      launch: function (id) { return Promise.resolve({ ok: true, term: id }); }
    },
    term: {
      start: function () { return Promise.resolve({ ok: true }); },
      write: function () { return Promise.resolve({ ok: true }); },
      resize: function () { return Promise.resolve({ ok: true }); },
      kill: function () { return Promise.resolve({ ok: true }); },
      snapshot: function () { return Promise.resolve({ running: true, buf: 'C:\\workspace>' }); }
    },
    update: {
      check: function () { return Promise.resolve({ current: '0.6.0', latest: '0.6.1', available: true, notes: '가짜 변경 내용' }); },
      apply: function () { return Promise.resolve({ ok: true }); }
    },
    app: {
      version: function () { return Promise.resolve('0.6.0'); },
      copy: function () { return Promise.resolve({ ok: true }); }
    },
    shell: {
      openPath: function () { return Promise.resolve(); },
      pickDir: function () { return Promise.resolve('C:\\workspace'); }
    },
    on: function (ch, cb) {
      listeners[ch] = listeners[ch] || [];
      listeners[ch].push(cb);
      return function () {
        listeners[ch] = listeners[ch].filter(function (f) { return f !== cb; });
      };
    }
  };
})();
