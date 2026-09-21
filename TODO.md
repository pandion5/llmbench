# 할 일

2026년 9월 21일 기준. 셋업 프로그램과 클라이언트가 WireGuard 터널로 붙어
하네스까지 도는 것을 확인한 다음 남은 것들이다.

## Codex 검토에서 나온 것

원문은 `.rabbits/reports/2026-09-21-codex-wireguard-review.md`에 있다.

### 8080이 일곱 군데에 박혀 있다

```
src/server.js:10                    const PORT = 8080;
src/wireguard.js:23                 const API_PORT = 8080;
src/renderer/app.js:1146            ':8080'
src/install.js:728                  --port 8080
src/client/tunnel.js:150            `http://${s.serverAddress}:8080`
src/renderer/mock-api.js:585        listen: { port: 8080, ... }
src/client/renderer/mock-api.js:20  baseUrl: 'http://10.66.0.1:8080'
```

포트를 바꾸면 클라이언트가 못 붙는다. 초대 코드에 포트를 실어 보내고
클라이언트가 그 값을 쓰게 하는 것이 순서상 먼저다.

### 피어 삭제와 키 회전이 살아 있는 터널에 즉시 안 먹는다

설정 파일은 바뀌지만 돌고 있는 터널에는 반영되지 않는다. 지운 기기가
계속 붙어 있을 수 있다. 터널을 내렸다 올리거나 `wg set`으로 바로
적용해야 한다.

### 설정 파일이 평문이다

`wireguard.json`과 `connection.json`에 개인 키와 API 키가 그대로 있다.
`icacls`로 권한을 잠그고는 있는데 종료 코드를 확인하지 않아서 실패해도
모른다. 최소한 실패를 알아차리게는 해야 한다.

### API 키가 프로세스 명령행에 들어간다

`--api-key`로 넘기고 있어서 같은 PC의 다른 프로세스가 작업 관리자나
`wmic`로 볼 수 있다. 환경 변수나 파일로 넘기는 방법을 찾아본다.

## 아직 안 한 측정

3.6-35B 단독 표준 벤치를 안 쟀다. 3.8은 IQ3_XXS 기준으로 llama-bench
tg128 16.7, 체감 20.3 tok/s까지 확인했다.

## 보류

벤치 결과를 웹에 올리는 일. 나중에 하기로 했다.

## 처리한 것

2026년 9월 21일, 0.9.0에서 처리했다.

### 터미널 복사, 붙여넣기, 줄바꿈

Ctrl+V와 Ctrl+Shift+V로 붙여넣는다. 여러 줄은 xterm의 paste로 넘겨서
브라켓 페이스트로 들어간다. 고른 글이 있을 때 Ctrl+C를 누르면 복사되고,
고른 게 없으면 중단 신호가 그대로 간다. 오른쪽 클릭은 고른 게 있으면
복사, 없으면 붙여넣기다. Shift+Enter는 보내지 않고 줄만 바꾼다.

### 허가 묻지 않기

하네스 탭에 체크 상자를 넣었다. 켜면 OpenClaude는
`--dangerously-skip-permissions`, Qwen Code는 `--yolo`로 뜬다.
기본은 꺼져 있고, 켜면 확인 없이 파일을 고치고 명령을 돌린다는 안내를
상자 아래에 붙여 뒀다.

### 작업 폴더

클라이언트에서 폴더를 안 고르면 홈에서 시작하던 것을 막았다. 비어 있으면
띄우지 않고 폴더를 먼저 고르라고 한다. 마지막에 쓴 폴더는 기억한다.

### 비용 표시

OpenClaude를 띄울 때 `~/.claude/settings.json`의 `modelPricing`에 그
모델의 단가를 0으로 적는다. 기존 설정은 읽어서 합치고, 파일이 깨져 있으면
덮어쓰지 않고 그만둔다.
