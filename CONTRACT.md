# llmbench IPC 계약

renderer ↔ main 통신 규약. W1(백엔드)과 W2(UI)가 이 문서만 보고 각자 구현한다. 변경 금지.

## preload가 노출하는 `window.api`

모든 함수는 Promise 반환. 이벤트는 `api.on(channel, cb)`로 구독, 해제 함수 반환.

### 점검 (check)
- `api.check.run()` → `CheckReport`
  - 완료 시 main이 `<앱 폴더>/logs/spec-logs/<COMPUTERNAME>-spec.json`에 `{ ts, computer, report: CheckReport, config: Config }`를 저장(덮어쓰기). CheckReport에 `specLogPath: string`을 추가해 돌려준다.
```ts
CheckReport = {
  ok: boolean,                // 전 항목 pass
  items: CheckItem[],
  hw: HwInfo
}
CheckItem = { id: string, label: string, status: 'pass'|'warn'|'fail', value: string, need: string }
// id 목록(고정): admin, gpu, vram, ram, disk, ssd, node, nvidia_driver
HwInfo = {
  gpu: { name: string, vramMB: number, driver: string } | null,
  cpu: { name: string, cores: number, threads: number },
  ramGB: number,
  ram: { totalGB: number, speedMTs: number|null, modules: number, bandwidthGBps: number|null },  // bandwidth ≈ modules(=채널 근사) × 8B × MT/s / 1000. 듀얼채널 DDR5-4800 2모듈이면 76.8
  drives: { letter: string, freeGB: number, totalGB: number, media: 'SSD'|'HDD'|'Unknown' }[],
  ssd: { letter: string, writeMBps: number, readMBps: number } | null   // 설치 대상 드라이브 간이 측정
}
```
판정 기준: admin=관리자 권한, gpu=NVIDIA 있음, vram≥12GB(warn: 8~12), ram≥64GB(warn 32~64), disk=설치 드라이브 여유≥140GB(Q4) / 110GB(IQ3), ssd=설치 드라이브 SSD(HDD면 warn), node 존재(하네스 탭 npm 설치용), nvidia_driver 존재.

### 설정 (config)
- `api.config.get()` → `Config`
- `api.config.export()` → `{ path: string|null, error }`  저장 대화상자로 현재 설정을 JSON으로 쓴다. 취소면 path null.
- `api.config.import()` → `{ config: Config|null, path, error }`  열기 대화상자로 JSON을 읽어 config.set에 넣는다. 잘못된 값은 걸러진다.
- `api.config.set(partial)` → `Config`
```ts
Config = {
  installDir: string,        // 기본 C:\llm\qwen
  quant: 'UD-Q4_K_XL'|'UD-IQ3_XXS'|'UD-Q3_K_XL',
  threads: number,           // 기본 물리 P코어 수
  ctx: number,               // 기본 65536
  kwhPrice: number,          // 원/kWh, 기본 150
  autoLoad36: boolean,       // 서버 시작 시 3.6도 로드. 기본 true. models.ini [qwen36] load-on-startup에 반영
  mtp: boolean,
  mtpFile: string,           // MTP 헤드 파일명. 기본 mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf. shared 계열은 본체 임베딩을 빌려 쓴다
  loadMode: 'mmap'|'none',   // models.ini [*] load-mode 드래프트. 기본 false. true면 llama.cpp를 unsloth 빌드로 받고 MTP 사이드카를 받아 [qwen38]에 model-draft/spec-type=draft-mtp/spec-draft-n-max=2 추가. bin/llmbench-build.json으로 빌드 종류 추적
  ncmoe38: number,           // 3.8 n-cpu-moe. 기본 99(전부 CPU). 0~99. models.ini와 llama-bench -ncmoe에 반영
  poll: number,              // llama-server --poll 0~100. 기본 50. models.ini [*] poll
  cpuMask: string            // llama-server --cpu-mask 16진수 문자열. ''이면 안 씀. 있으면 cpu-strict = true도 함께
}
```
저장 위치: `app.getPath('userData')/config.json`

### 설치 (install)
- `api.install.start(opts?)` → `{ started: boolean, reason: string|null }`
  - opts = `{ allowWarn?: boolean }`. 직전 CheckReport 기준: fail이 하나라도 있으면 started=false(admin fail 포함. 단 환경변수 LLMBENCH_NO_ELEVATE=1이면 admin은 무시). warn만 있으면 allowWarn=true일 때만 시작. UI는 warn 있을 때 확인 문구를 띄운 뒤 allowWarn=true로 재호출한다. reason에 차단 사유 한 줄.
- `api.install.cancel()` → void
- `api.install.status()` → `InstallStatus`
- 이벤트 `install:progress` → `InstallStatus`
```ts
InstallStatus = {
  running: boolean,
  steps: InstallStep[],
  log: string[]              // 최근 200줄
}
InstallStep = {
  id: 'llamacpp'|'model38'|'model36'|'preset'|'runbat',
  label: string,
  status: 'pending'|'running'|'done'|'error'|'skipped',
  percent: number|null,      // 다운로드형 단계만
  detail: string             // 예: "46.2GB / 111GB  38MB/s"
}
```
단계 로직은 `../qwen38-installer/setup.ps1`과 동일. 이미 존재하는 파일은 skipped.

### 서버 (server)
- `api.server.start()` / `api.server.stop()` → `ServerStatus`
- `api.server.logs()` → `string[]`  llama-server가 내보낸 최근 줄. 대시보드 서버 로그 카드에 그대로 보여준다.
- `api.server.saveLogs()` → `{ path: string }`  같은 줄을 앱 폴더 `logs/server-logs/<COMPUTERNAME>-server-<ts>.log`에 저장한다.
- `api.server.status()` → `ServerStatus`
- 이벤트 `server:status` → `ServerStatus`
  - 라우터 `/models`의 항목은 `status: { value: 'loaded'|'unloaded'|'loading'|... }` 객체다. `loaded = status.value === 'loaded'`. 서버가 stopped/error면 models는 빈 배열.
```ts
ServerStatus = {
  state: 'stopped'|'starting'|'ready'|'error',
  pid: number|null,
  models: { id: string, loaded: boolean }[],   // GET /models
  error: string|null
}
```
llama-server를 router 모드(`--models-preset`)로 spawn. ready 판정은 `GET /health` 200.

### 모니터 (monitor)
- `api.monitor.snapshot()` → `Snapshot`
- 이벤트 `monitor:tick` (1초) → `Snapshot`
```ts
Snapshot = {
  ts: number,
  gpu: { utilPct: number, memUsedMB: number, memTotalMB: number, powerW: number, tempC: number } | null,
  ram: { usedGB: number, totalGB: number },
  cpuPct: number,
  disk: { letter: string, freeGB: number },    // installDir 드라이브
  ssd: { letter: string, writeMBps: number, readMBps: number } | null,   // 마지막 점검(check.run)에서 측정한 값 캐시. 점검 전이면 null
  lastBench: { model: string, genTokPerSec: number, promptTokPerSec: number, ts: number } | null   // 이 세션 마지막 벤치 요약. 없으면 null
}
대시보드는 ssd와 lastBench를 카드로 표시한다(값 없으면 "점검 전"/"벤치 전").
```

### 벤치마크 (bench)
- `api.bench.run(opts)` → `BenchResult`
- `api.bench.cancel()` → void
- 이벤트 `bench:progress` → `{ promptIdx: number, total: number, tokens: number, tokPerSec: number, text: string }`
```ts
opts = { model: string, mode?: 'standard'|'prompts'|'tuning', prompts?: string[] }
// mode 'tuning': llama-bench 한 번에 -t 4,6,8,12,16 × --poll 0,50 × -C 0x0,<P코어 마스크> 조합을 tg128만 2회씩 잰다.
// 결과 BenchResult.tuning = { gguf, ncmoe, rows: [{threads, poll, cpuMask, tg128, stddev}](빠른 순), best: {threads, poll, cpuMask('' 가능)}, currentTg128: number|null, seconds }. verdict 없음, summary.avgGenTokPerSec = best.tg128.
// mode 'standard'(기본 UI 선택): llama-bench로 pp512/tg128 측정. model은 'qwen38'|'qwen36'. 실행 중인 llama-server는 먼저 내린다.
// mode 'prompts': 서버에 내장 3종(또는 prompts) 전송.
BenchResult = {
  mode: 'standard'|'prompts'|'tuning',
  model: string,
  runs: BenchRun[],            // standard면 []
  standard?: { gguf, build, threads, ncmoe, reps, pp512: {avgTs, stddevTs}, tg128: {avgTs, stddevTs}, seconds, whPer1kGenTokens },
  summary: {
    avgPromptTokPerSec: number,   // prompt processing
    avgGenTokPerSec: number,      // generation
    avgPowerW: number,            // GPU 평균 전력(측정 구간)
    totalWh: number,              // GPU 에너지
    krw: number,                  // totalWh/1000 * kwhPrice
    krwPer1kTokens: number
  },
  hw: HwInfo,
  verdict: Verdict,
  ts: number
}
// 판정. 생성 속도 목표 20 tok/s 기준. MoE 생성 속도는 GPU가 아니라 RAM 대역폭에 묶인다는 전제.
Verdict = {
  target: 20,
  genTokPerSec: number,
  reached: boolean,
  bottleneck: 'ram_capacity'|'ram_bandwidth'|'gpu'|'unknown',   // ram_capacity: 모델 합계 > RAM(디스크 스트리밍), ram_bandwidth: RAM엔 들어가는데 대역폭 한계, gpu: GPU 전력·사용률이 포화
  modelBytesGB: number,               // 로드 대상 모델 파일 합계(3.8 + 3.6이 load-on-startup이면 둘 다)
  ramTotalGB: number,
  bytesPerTokenGB: number|null,       // = bandwidthGBps / genTokPerSec (대역폭 알 때만)
  neededBandwidthGBps: number|null,   // = bandwidthGBps × target / genTokPerSec
  quantDownGain: number,              // Q4→IQ3_XXS 예상 배율(파일 크기 비, 약 1.3)
  quantDownTokPerSec: number,         // genTokPerSec × quantDownGain
  quantDownReaches: boolean,          // 양자화만 낮춰 20 도달하는가
  actions: string[]                   // 사람이 읽는 처방 1~4줄. 예: "3.6 자동 로드 해제(RAM 21GB 확보)", "RAM 대역폭 1.4배 필요: DDR5-6000 듀얼 이상", "전문가 VRAM 캐시 포크(5070Ti 43 tok/s 보고)"
}
BenchRun = { prompt: string, promptTokens: number, genTokens: number, promptTokPerSec: number, genTokPerSec: number, seconds: number, avgPowerW: number, wh: number, timingsSource: 'server'|'client', answer: string, truncated: boolean }
// answer는 답변 전문(화면 '답변 전문' 카드와 JSON에 그대로). max_tokens 2048, truncated는 그 상한에 걸린 경우.
```
tok/s는 llama-server 응답의 `timings`(prompt_per_second, predicted_per_second) 사용. 스트리밍 요청은 body에 `timings_per_token: true`를 넣어야 마지막 청크에 timings가 실린다. timings가 없으면 클라이언트 측 측정값으로 대체하고 BenchRun.timingsSource='client'로 표기(있으면 'server'). 전력은 벤치 중 `nvidia-smi --query-gpu=power.draw` 1초 샘플 평균.
- `api.bench.export()` → `{ path: string }`  마지막 결과를 앱 폴더 `logs/bench-logs/<COMPUTERNAME>-bench-<ts>.json`으로 저장하고 경로 반환. 앱 폴더에 쓸 수 없으면 `userData/logs/bench-logs`.

### 하네스 (harness)
채팅 탭 대체. 코딩 에이전트 CLI를 외부 터미널 창으로 띄운다(앱 안 내장 아님). 의존성 추가 없음.
- `api.harness.list()` → `HarnessInfo[]`
- `api.harness.install(id)` → `HarnessInfo` (npm 전역 설치. `cmd /c npm install -g <pkg>`. 진행은 이벤트 `harness:log`로 줄 단위)
- `api.harness.launch(id, opts)` → `{ ok: boolean, error: string|null }`
- 이벤트 `harness:log` → `string`
```ts
HarnessInfo = { id: 'qwen-code'|'opencode', name: string, npm: string, installed: boolean, version: string|null, note: string }
opts = { workDir: string, model: 'qwen38'|'qwen36' }   // workDir 비우면 installDir\workspace
```
launch 동작:
- qwen-code: `~/.qwen/settings.json`을 병합 갱신(modelProviders.openai에 llama-server 항목 `{id:<model>, name, baseUrl:'http://127.0.0.1:8080/v1', envKey:'OPENAI_API_KEY'}`, `security.auth.selectedType='openai'`, `model.name=<model>`; 기존 파일은 `.bak`). 환경변수 `OPENAI_BASE_URL`, `OPENAI_API_KEY=local`, `OPENAI_MODEL=<model>`을 세팅한 새 콘솔 창(`cmd /c start "llmbench qwen" /D <workDir> cmd /k qwen`)을 띄운다.
- opencode: 터미널 열기 때 `~/.config/opencode/opencode.json`을 써 넣고(.bak 백업) 새 콘솔 창에서 `opencode` 실행(TUI).
- llama-server가 ready가 아니면 ok=false, error에 안내.

### 기타
### 진단 (diag)
설정, 하드웨어, models.ini, bin 구성, 모델 파일 목록, 서버 상태와 로그를 한 텍스트로 묶는다.
- `api.diag.copy()` → `{ chars: number }`  클립보드에 넣는다.
- `api.diag.share()` → `{ url: string, chars: number }`  paste.rs에 올리고 주소를 돌려준다. 공개로 올라가므로 화면에서 확인을 받은 뒤에만 부른다.

### 공유 (wg)
WireGuard 터널과 기기를 다룬다. 개인 키는 `info`에 나오지 않는다.
- `api.wg.info()` → `{ installed, version, configured, serverPublicKey, address, port, endpoint, apiKey, peers, status }`
- `api.wg.publicIp()` → `string|null`
- `api.wg.localIps()` → `[{ name, address, virtual }]`  같은 공유기 안에서 쓸 주소 후보. 가상 어댑터는 뒤로 민다
- `api.wg.up()` / `api.wg.down()` → `{ ok }`  터널 서비스를 올리거나 내린다
- `api.wg.addPeer(name)` → `{ name, address, publicKey, privateKey }`
- `api.wg.removePeer(name)` → `{ ok }`
- `api.wg.setEndpoint(ep)` → `{ endpoint }`
- `api.wg.rotateApiKey()` → `{ apiKey }`  키를 새로 만든다. 서버를 다시 시작해야 걸린다
- `api.wg.peerConf(name)` → `string`  기기에 넣을 설정. 개인 키가 들어 있다
- `api.wg.savePeerConf(name)` → `{ saved, path }`
- `api.server.start({ share })` → share가 참이면 모든 주소에서 받고 API 키를 건다

### 터미널 (term)
ConPTY 세션을 앱 안에서 다룬다. 세션 id는 하네스 id를 그대로 쓴다.
- `api.term.start(id, opts)` → `{ ok, reused, pid }`  opts는 `{ file, args, cwd, env, cols, rows }`
- `api.term.write(id, data)` → `{ ok }`  키 입력을 그대로 보낸다
- `api.term.resize(id, cols, rows)` → `{ ok }`
- `api.term.kill(id)` → `{ ok }`
- `api.term.snapshot(id)` → `{ running, buf }`  화면을 다시 그릴 때 쓴다
- 이벤트 `term:event` → `{ type: 'data'|'exit', id, data?, exitCode? }`

- `api.shell.openPath(p)`
- `api.app.version()` → string  package.json version
- `api.update.check()` → `{ current, latest: string|null, available: boolean, notes, zipUrl, sha256, error: string|null }`  원격 update.json(GitHub Release latest)과 비교. 네트워크 실패면 available false + error.
- `api.update.apply()` → `{ ok, error }`  zip 다운로드 → sha256 검증 → userData/update/staging에 해제 → 교체 배치 실행 → 앱 종료. 배치가 src·package.json·문서를 덮어쓰고 start.bat 재실행.
- 이벤트 `update:progress` → `{ stage: 'download'|'extract'|'restart'|'error', percent: number, text: string }`
- `api.app.isAdmin()` → boolean
