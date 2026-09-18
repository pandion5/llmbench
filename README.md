# llmbench

로컬 LLM(Qwen3.8-Flash-Next + Qwen3.6-35B, llama.cpp router) 환경을 점검·설치·모니터링·벤치마크하는 Electron 앱. Windows 전용.

## 실행

```
npm install
npm start
```

배포본(Release의 포터블 zip)은 `llmbench-win32-x64\llmbench.exe`를 실행한다. 관리자 권한 매니페스트가 들어 있어 UAC를 거쳐 뜬다. 앱 파일은 `resources\app` 아래 있고 업데이트는 그 폴더만 바꾼다. 소스 폴더에서 바로 띄울 땐 `llmbench.vbs`(콘솔 없음) 또는 `start.bat`.

관리자 권한이 아니면 UAC 창을 띄워 자기 자신을 다시 실행한다. 개발 중 승격을 건너뛰려면 `LLMBENCH_NO_ELEVATE=1`을 준다.

## 화면

- 점검: GPU, VRAM, RAM, 설치 드라이브 여유·SSD 여부·속도, Node, 드라이버, 관리자 권한을 확인한다. fail이 있으면 설치 버튼이 막히고, warn만 있으면 확인 후 진행한다. 드라이브 목록에서 설치 위치를 고를 수 있고, RAM은 속도·모듈 수·추정 대역폭까지 보여준다. 결과는 앱 폴더 `logs/spec-logs/<컴퓨터이름>-spec.json`에 저장한다. 앱 폴더에 쓸 수 없으면 `%APPDATA%\llmbench\logs\spec-logs`에 저장한다.
- 설치: 설치 경로, 양자화, 스레드 수, 컨텍스트, 전기요금 단가, 3.6 자동 로드 여부, 3.8 CPU 전문가 층 수(n-cpu-moe), poll, CPU 마스크, MTP 드래프트를 설정한다. MTP를 켜면 llama.cpp를 unsloth 포크 빌드로 바꿔 받고 MTP 사이드카(2.6GB)를 함께 받는다. 본가 llama.cpp엔 아직 MTP가 없다. 양자화는 Q4_K_XL, Q3_K_XL, IQ3_XXS, Q2_K_XL, IQ1_M 다섯 가지다. RAM이 두 모델 합계보다 작으면 자동 로드를 끄고 3.8만 올린다. llama.cpp 다운로드, 모델 두 개 다운로드, models.ini, run.bat 생성 순서로 진행 상황과 로그를 보여준다. 로직은 `../qwen38-installer/setup.ps1`과 같다.
- 대시보드: GPU 사용률·VRAM·전력·온도, RAM, CPU, 디스크, SSD 속도, 마지막 벤치 tok/s를 1초마다 갱신한다. 전력은 시간당 전기요금으로 환산해 같이 표시한다. llama-server 시작·정지와 모델 로드 상태도 여기서 본다.
- 벤치마크: 기본은 llama.cpp 동봉 llama-bench로 pp512(프롬프트 처리)·tg128(생성) tok/s를 3회 평균해 잰다. 커뮤니티·모델 카드와 같은 지표라 다른 PC와 비교할 수 있다. 실행 중인 서버는 먼저 내린다. 체감 모드는 내장 프롬프트 3종을 서버에 보내 프롬프트 처리 tok/s, 생성 tok/s, 소요 시간, 평균 전력, Wh, 원화 비용, 1000토큰당 비용을 낸다. 결과는 앱 폴더 `logs/bench-logs/<컴퓨터이름>-bench-<시각>.json`으로 저장한다. 튜닝 모드는 llama-bench 한 번으로 스레드 4/6/8/12/16, poll 0/50, CPU 마스크(없음, P코어만) 조합을 tg128만 재서 빠른 순으로 표를 만든다. 가장 빠른 조합을 버튼 하나로 설정에 적용한다. 결과 아래 판정 카드에 생성 20 tok/s 목표 대비 부족분, 병목(RAM 용량·RAM 대역폭·GPU), 양자화를 한 단계 낮췄을 때 예상 tok/s와 처방을 적는다.

- 하네스: 코딩 CLI(Qwen Code, OpenCode)의 설치 여부와 버전을 표로 보여준다. 설치 버튼은 `npm install -g`를 돌리고, 터미널 열기는 작업 폴더에서 새 콘솔 창을 띄워 CLI를 실행한다. CLI는 환경변수로 로컬 llama-server(127.0.0.1:8080)와 선택한 모델을 쓰도록 설정된다. 서버가 떠 있어야 열린다.

## 업데이트와 배포

앱은 시작할 때 GitHub Release의 `update.json`을 읽어 package.json 버전보다 높으면 상단에 "새 버전 업데이트" 버튼을 보인다. 누르면 업데이트 zip(수백 KB)을 받아 sha256을 확인하고 앱을 닫은 뒤 배치 파일이 `src`, `package.json`, 문서, `start.bat`을 바꾸고 다시 띄운다. electron 본체(node_modules)는 그대로 둔다.

배포는 개발 PC에서 다음 한 줄이다. 버전을 올리고 dist에 업데이트 zip, 포터블 zip, update.json을 만들어 GitHub Release에 올린다.

```
node scripts/release.js 0.2.1 --notes "바뀐 내용" --publish
```

`--publish`를 빼면 dist만 만든다. 포터블 zip은 `@electron/packager`로 만든 `llmbench.exe` 폴더다. 처음 설치하는 PC에는 이 zip을 준다.

## 구조

- `src/main.js` 창·IPC·관리자 승격
- `src/preload.js` `window.api` 노출(계약은 `CONTRACT.md`)
- `src/sys.js` 하드웨어 조회, 점검 판정, 모니터 스냅샷
- `src/config.js` 설정 저장(`%APPDATA%\llmbench\config.json`)
- `src/install.js` 설치 단계 상태 머신
- `src/server.js` llama-server 기동·헬스체크
- `src/bench.js` 벤치마크·전력 샘플링
- `src/harness.js` 코딩 CLI 조회·설치·터미널 실행
- `src/update.js` 업데이트 확인·적용
- `scripts/release.js` 릴리스 묶음 생성·GitHub Release 게시
- `src/renderer/` 화면. `index.html`을 브라우저에서 직접 열면 `mock-api.js`로 목 동작한다.

## 아직 확인 안 된 것

- 실제 llama-server를 붙인 서버·벤치 흐름. 이 PC에 모델을 아직 받지 않았다.
- 모델 다운로드는 파일마다 4연결로 나눠 받고 구간별 진행을 `<파일>.parts.json`에 남긴다. 끊기면 구간마다 이어받는다. 400MB 파일로 강제 종료·이어받기·sha256 일치를 확인했고, 100GB급 실제 파일로는 아직 확인하지 않았다.
- 전력은 GPU만 nvidia-smi로 잰다. CPU·메인보드 전력은 포함되지 않아 실제 전기요금보다 낮게 나온다.
