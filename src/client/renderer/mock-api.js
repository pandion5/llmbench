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
          { id: 'openclaude', name: 'OpenClaude', note: 'Claude Code 계열 CLI', installed: true, version: '1.0.0' },
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
    usage: {
      status: function () {
        return Promise.resolve({
          listening: true, error: null, limit: 1,
          running: [{ id: 3, who: '박영범', address: '10.66.0.2', model: 'qwen38', waitMs: 0, runMs: 4200, tokens: 0, stage: 'prompt', promptPct: 61, promptTokens: 13360 }],
          waiting: [{ id: 4, who: '노트북', address: '10.66.0.3', model: 'qwen38', waitMs: 3100, runMs: 0, tokens: 0 }]
        });
      },
      server: function () {
        return Promise.resolve({
          status: { state: 'ready', models: [{ id: 'qwen38', loaded: true }, { id: 'qwen36', loaded: false }] },
          logs: ['srv  info: loading model qwen38', 'srv  info: model loaded in 84.2s', 'srv  info: listening on 127.0.0.1:8081'],
          events: [
            { at: new Date().toISOString(), who: '박영범', address: '10.66.0.2', action: '서버 켜기', ok: true, error: null },
            { at: new Date(Date.now() - 3600000).toISOString(), who: '노트북', address: '10.66.0.3', action: '서버 끄기', ok: false, error: '서버가 이미 꺼져 있다' }
          ]
        });
      },
      serverStart: function () { return Promise.resolve({ ok: true }); },
      serverStop: function () { return Promise.resolve({ ok: true }); },
      serverUpdateCheck: function () { return Promise.resolve({ current: '0.10.3', latest: '0.11.0', available: true, notes: '', error: null }); },
      serverUpdateApply: function () { return Promise.resolve({ ok: true }); },
      bench: function () {
        return Promise.resolve({
          busy: false, error: null, progress: null,
          last: { mode: 'ncmoe', model: 'qwen38', ts: Date.now(), ncmoe: {
            gguf: 'Qwen3.8-UD-IQ3_XXS-00001-of-00004.gguf', current: 99, seconds: 412,
            rows: [
              { ncmoe: 48, ok: true, pp512: 121.3, tg128: 16.7 },
              { ncmoe: 44, ok: true, pp512: 138.9, tg128: 17.9 },
              { ncmoe: 40, ok: true, pp512: 157.2, tg128: 19.4 },
              { ncmoe: 36, ok: false, pp512: null, tg128: null, error: 'cudaMalloc failed' }
            ],
            best: { ncmoe: 40, pp512: 157.2, tg128: 19.4 }, currentPp512: 121.3, currentTg128: 16.7
          } }
        });
      },
      benchRun: function () { return Promise.resolve({ ok: true }); },
      benchApply: function () { return Promise.resolve({ ok: true, ncmoe38: 44 }); },
      benchCancel: function () { return Promise.resolve({ ok: true }); },
      days: function () { return Promise.resolve(['2026-09-22', '2026-09-21']); },
      log: function () {
        return Promise.resolve([
          { at: new Date().toISOString(), who: '이 PC', address: '127.0.0.1', model: 'qwen36',
            waitMs: 0, runMs: 16200, tokens: 60, prompt: '한국에서 제일 높은 산은?', answer: '백두산이 2744m로 가장 높다.' },
          { at: new Date().toISOString(), who: '박영범', address: '10.66.0.2', model: 'qwen38',
            waitMs: 2400, runMs: 88000, tokens: 1024, promptTokens: 6200, promptMs: 41000, genMs: 47000, prompt: 'src/wireguard.js를 읽고 다섯 줄로 정리해줘', answer: '터널 서비스를 올리고 내린다.' }
        ]);
      }
    },
    app: {
      version: function () { return Promise.resolve('0.6.0'); },
      copy: function () { return Promise.resolve({ ok: true }); },
      paste: function () { return Promise.resolve('붙여넣은 글'); },
      workspace: function () { return Promise.resolve('C:\\llmbench\\workspace'); }
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
