# WireGuard 공유 코드 검토

검토일: 2026-09-21. 대상은 현재 작업 디렉터리의 소스이며 줄 번호도 이 상태 기준이다. 앱·llama-server·터널을 실행하지 않았고 네트워크 설정을 변경하지 않았다. netsh는 `add rule ?` 도움말만 조회했으며 규칙을 추가·삭제하지 않았다. 대상 PC의 실제 리스너, 라우팅 테이블, 유효 방화벽 정책, 파일 ACL, 설치된 llama.cpp 버전은 확인하지 않았다. 외부 자료는 공식 Microsoft·WireGuard 문서와 llama.cpp 본가 및 unsloth 소스를 읽었다.

**판단:** 공유 설정 영속화 수정은 유력한 원인 하나를 해결한다. 그러나 현재 장애의 근본 원인이었다고 확정할 증거는 없다. 먼저 서버의 실제 8080 리스너가 `127.0.0.1`인지 `0.0.0.0`인지 구분해야 한다. 핸드셰이크 성공은 TCP 8080까지의 성공을 뜻하지 않으며, ping 실패도 TCP 차단의 증거는 아니다.

## 1. TCP 8080에 닿지 않는 원인 후보 — 우선순위

아래 순서는 제공된 증상과 코드에 근거한 조사 우선순위이며 통계적 확률은 아니다. 핸드셰이크와 124/1972 바이트, TCP 실패, ping 실패는 요청자가 제공한 관측으로 이번 검토에서 재현하지 않았다.

| 순위 | 후보 및 코드 근거 | 판단과 구분 방법 |
|---|---|---|
| 1 | 공유가 꺼진 상태로 기동했거나 공유 저장 후 서버를 재시작하지 않아 루프백 리스너가 남음. `src/main.js:280-284`, `src/server.js:118-119`, `src/server.js:138-147`, `src/renderer/app.js:1193-1198`. | 가장 직접적으로 증상을 설명한다. `server.start()`는 기존 자식이 살아 있으면 즉시 반환하므로 시작 버튼을 다시 누르는 것만으로 인자가 갱신되지 않는다. 실제 리스너가 `127.0.0.1:8080`이면 원인이 확인된다. 공유를 저장한 뒤 중지·재시작이 필요하다. |
| 2 | TCP 허용 규칙이 존재하지만 실제로 적용되지 않음: 비활성/변경된 규칙, 명시적 차단, 프로필별 로컬 규칙 병합 금지, 타사 보안 필터 등. `src/wireguard.js:210-236`, `src/renderer/app.js:1071-1073`. | UI는 이름으로 `show rule`이 성공했는지만 본다. Action, Enabled, Profile, 포트, 주소, 유효 정책을 검사하지 않는다. `up()`은 `allowFirewall()`의 `{ok:false}`도 무시한다(`src/wireguard.js:198-199`). ‘열림’은 통신 성공 보증이 아니다. 실제 리스너가 전체 주소라면 이 후보를 우선 조사한다. |
| 3 | llama-server가 없거나 실패했고, 다른 프로세스/루프백 서버 상태를 오인함. `src/server.js:121-131`, `src/server.js:153-180`, `src/server.js:61-76`. | 준비 검사는 항상 `127.0.0.1:8080/health`이며 PID 소유권이나 터널 접근을 확인하지 않는다. 포트 충돌·기동 실패·모델 설정 오류는 로그와 리스너 PID를 대조해야 한다. 준비 표시만으로 터널 리스너를 증명할 수 없다. |
| 4 | 실제 적용된 터널 주소/AllowedIPs/경로가 저장 상태와 다르거나 다른 VPN의 경로와 충돌. `src/wireguard.js:101-125`, `src/wireguard.js:140-155`, `src/wireguard.js:190-198`, `src/client/tunnel.js:69-88`, `src/client/tunnel.js:103-117`. | 정상 생성값은 서버 주소 `10.66.0.1/24`, 서버 피어 `10.66.0.2/32`, 클라이언트 주소 `/32`, 클라이언트 AllowedIPs `/24`로 타당하다. 하지만 피어 추가·삭제와 초대 적용은 저장만 하며 살아 있는 터널을 갱신하지 않는다. 핸드셰이크는 키/UDP 경로 증거이지 내부 IP 소스 허용과 OS 경로의 증거가 아니다. |
| 5 | 서버를 다른 포트로 바꿨으나 클라이언트와 방화벽은 계속 8080 사용. `src/server.js:10`, `src/wireguard.js:23`, `src/client/tunnel.js:150`, `src/renderer/app.js:1140`. | 현재 소스의 값은 모두 8080이므로 현재 장애 원인으로 확인되지 않았다. 다른 실행 경로나 수동 변경이 있을 때만 유력하다. |
| 6 | 외부 UDP 경로가 현재는 끊겼는데 오래된 핸드셰이크/누적 바이트를 현재 연결로 해석. `src/client/tunnel.js:125-143`, `src/wireguard.js:240-260`. | 코드의 running은 `wg show` 성공이며 핸드셰이크 신선도나 증가하는 바이트를 판단하지 않는다. 최신 핸드셰이크가 계속 갱신된다면 NAT hairpin·UDP 포워딩 문제의 우선순위는 낮다. 같은 LAN에서는 endpoint `192.168.0.74:51820`이 직접 경로다. |

`serve`는 이제 파일에 기록되고 다시 읽히므로 재실행 시 체크가 풀리는 경로는 수정되어 있다(`src/wireguard.js:158-167`, `src/main.js:283`). 다만 기존 파일에 필드가 없으면 false이고 JSON 읽기 실패도 null로 처리된다(`src/wireguard.js:68-73`). 수정 후에도 한 번은 공유를 명시적으로 켜서 저장하고 서버를 새로 띄워야 한다. 이전 버그의 발생 이력과 수정 후 실제 프로세스 인자는 이번 검토로 확인하지 못했다.

API 키 불일치는 HTTP 인증 문제로, 그 자체로 `TcpTestSucceeded=False`를 설명하지 못한다. 모델 로딩/라우터 자식 오류도 부모가 8080에서 계속 리슨하는 한 TCP 실패와 별도로 다뤄야 한다. ping용 ICMP 허용 규칙은 구현에 없으므로 ping 실패만으로 터널 실패라고 결론 내릴 수 없다(`src/wireguard.js:212-222`).

## 2. netsh 규칙과 Windows 방화벽 프로필

현재 규칙은 외부 WireGuard 패킷용 UDP 51820 인바운드 허용과, 내부 API 패킷용 TCP 8080 인바운드 허용이다. `remoteip=10.66.0.0/24`는 **TCP 규칙에만** 붙는다(`src/wireguard.js:212-222`). UDP에 이 제한을 붙이면 외부 패킷 소스 `192.168.0.18`과 맞지 않으므로 현재 분리는 옳다.

정상 터널 경로에서는 복호화된 TCP 패킷의 소스가 `10.66.0.2`, 목적지가 `10.66.0.1`이다. 따라서 TCP remoteip 제한은 그 소스에 매칭될 수 있으며, WireGuard 어댑터라고 해서 주소 조건이 무시되는 구조는 아니다. `/24`처럼 `/0`이 아닌 구성은 일반 Windows 라우팅·방화벽 정책을 사용한다. 실제 PC에서 어떤 필터가 최종 판정을 했는지는 패킷/유효 정책을 보지 않아 확인하지 못했다. [WireGuard Windows 네트워크 동작](https://git.zx2c4.com/wireguard-windows/about/docs/netquirk.md)

`profile` 생략을 ‘개인 프로필에서만 허용’으로 해석하면 안 된다. netsh 신규 규칙은 일반적으로 전체 프로필(Any)을 기본으로 사용하며, 의도 표현과 점검 편의를 위해 `profile=any`를 명시하는 선택은 가능하다. 다만 이번에 조회한 로컬 도움말에는 profile 선택지는 있으나 그 기본값 설명이 없었고, 대상 PC에 생성된 규칙의 실제 Profile은 조회하지 않았다. 그러므로 생략 자체를 현재 장애 원인으로 확정하거나, 규칙이 반드시 Any라고 실측한 것처럼 말할 수 없다. [Microsoft netsh 문서](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-advfirewall)

WireGuard 네트워크가 Public/Private/DomainAuthenticated 중 무엇인지는 코드로 결정되지 않는다. 식별되지 않은 터널이 Public으로 분류될 가능성을 고려해야 하며, 물리 LAN이 Private이라고 터널도 Private인 것은 아니다. WireGuard 문서는 터널 구성으로부터 어댑터 GUID를 결정하고 구성 변경 시 GUID가 달라질 수 있다고 설명한다. 터널 재생성 뒤 프로필을 재확인해야 한다. **실제 프로필은 미확인**이다. 위 WireGuard 공식 문서의 Network List Manager 및 Adapter Lifetime 절이 근거다.

Any 허용 규칙이라도 명시적 block 규칙이 우선할 수 있고, 기업 정책에서 로컬 규칙 병합을 막으면 로컬 netsh 규칙이 기대대로 적용되지 않을 수 있다. 반대로 좁은 allow 규칙 하나를 넣었다고 다른 넓은 allow 규칙이 무효화되는 것도 아니다. 현재 규칙은 ‘터널 외 접속 거부’ 규칙이 아니다. [Microsoft 규칙 우선순위와 병합 설명](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)

권장 점검은 실제 Profile·Enabled·Action·TCP 포트·RemoteAddress와 ActiveStore 정책을 함께 확인하는 것이다. TCP 허용의 RemoteAddress를 LAN 대역으로 바꾸거나 방화벽 전체를 끄는 조치는 현재 증거로 정당화되지 않는다. 소스 주소 제한 외에 LocalAddress=`10.66.0.1` 및 실행 파일 범위를 좁히는 방안은 검토할 수 있지만, 인터페이스 이름/수명에 의존하는 정책은 재생성 후 유지 여부도 검증해야 한다.

## 3. 0.0.0.0 대신 터널 주소에만 바인드

현재 `--host 0.0.0.0`은 WireGuard 전용이 아니라 모든 IPv4 인터페이스를 대상으로 한다(`src/server.js:9-13`, `src/server.js:141`). `10.66.0.1` 전용 바인드는 물리 LAN 주소 `192.168.0.74`에서 직접 받지 않으므로, 다른 방화벽 allow 규칙이 있어도 노출 범위를 줄이는 장점이 있다. API 키와 방화벽은 계속 필요하다.

단점은 터널 주소가 만들어진 뒤에만 서버를 안정적으로 바인드할 수 있다는 점이다. 현재 서버 시작 IPC는 터널 준비 여부를 검사하지 않는다(`src/main.js:280-284`). 터널을 내렸다 올릴 때 서비스 상태를 조정하거나 재시작해야 할 수 있다. 또한 로컬 health·models·하네스는 `127.0.0.1:8080`에 의존한다(`src/server.js:11`, `src/server.js:61`, `src/server.js:97`, `src/harness.js:48`). SHARE_HOST만 바꾸면 이 경로가 실패한다.

터널 전용 바인드를 택한다면 서버 활성 URL을 한곳에서 관리하고 로컬 호출도 그 주소로 바꾸거나, 별도 루프백 프록시/복수 리스너를 설계해야 한다. 후자는 배포 llama.cpp의 지원 여부부터 확인해야 한다. 라우터 내부 자식의 루프백 통신은 외부 바인드와 별개다(6절).

## 4. 8080 하드코딩과 변경 지점

**서버 포트만 바꾸면 깨진다.** 요청 경로는 `src/client/main.js:49-52` → `tunnel.target()` → `src/client/chat.js:38`, `:112`, `:131`이다. 세 요청 모두 `src/client/tunnel.js:150`에서 만든 `http://<serverAddress>:8080`을 사용한다. 하네스도 같은 target을 전달받는다(`src/client/main.js:63-66`).

향후 수정 지점은 다음과 같다. 이번 검토에서는 수정하지 않았다.

| 지점 | 필요한 변경 |
|---|---|
| `src/server.js:10-11`, `:142` | 실제 API 포트와 활성 base URL의 단일 설정 원천 도입. |
| `src/wireguard.js:23`, `:221` | TCP 방화벽 localport를 실제 API 포트와 동기화. |
| `src/wireguard.js:342-353`, `:365-369` | 초대에 별도 `apiPort` 필드 추가 및 1~65535 정수 검증. 기존 LLMB1 초대는 명시적인 8080 기본값으로 호환하거나 버전을 올림. |
| `src/client/tunnel.js:85-88`, `:150` | 저장된 apiPort를 사용. 기존 connection.json의 마이그레이션/기본값 처리. |
| `src/wireguard.js:301-313`, `src/renderer/app.js:1140` | info에 API 포트를 전달하고 안내 주소에 반영. |
| `src/install.js:728` | 설치 시 생성하는 수동 서버 실행 명령도 동기화. 이 명령은 현재 루프백 8080으로 고정되어 공유 IPC를 거치지 않는다. |

`s.server.port`와 `info.port`는 **UDP WireGuard 포트**이므로 API 포트 대신 재사용하면 안 된다(`src/wireguard.js:89`, `:106`, `:307`, `:349`). 초대 발행 뒤 서버 포트를 바꾸면 이미 배포한 초대와 저장된 연결 정보도 갱신해야 한다.

## 5. 보안 검토

- **개인 키 평문 파일의 보호 불균형 — 코드 확인.** 서버 wireguard.json에는 서버·모든 피어 개인 키와 API 키가 저장되고 클라이언트 connection.json에도 초대 전체가 저장된다. 두 JSON에는 icacls를 호출하지만 종료 코드를 확인하지 않으며 먼저 평문을 쓴다(`src/wireguard.js:76-80`, `:89-92`, `:145`; `src/client/tunnel.js:63-66`, `:85-87`). `/inheritance:r`와 현재 사용자 `/grant:r`가 다른 계정의 기존 명시적 ACE까지 모두 없앤다고 보장할 수 없다. 실제 ACL은 미확인이다.
- **conf와 내보낸 파일은 별도 ACL 강화가 없음 — 코드 확인.** 서버·클라이언트 conf에 개인 키를 쓰고 일반 writeFile만 사용한다(`src/wireguard.js:104`, `:193`; `src/client/tunnel.js:72`, `:107`). 내보낸 피어 conf도 동일하다(`src/main.js:341-349`). 부모 폴더 ACL에 따라 실제 위험이 달라진다. WireGuard가 내부 저장소를 보호하더라도 앱이 작성한 원본 conf의 보호를 대신 입증하지는 않는다.
- **초대는 암호화·서명·일회성이 아님 — 코드 확인.** LLMB1은 개인 키와 공용 API 키를 담은 JSON의 base64url이다. 만료·소비 상태·서명 검증이 없다(`src/wireguard.js:333-369`). 복사본을 가진 사람은 같은 피어를 복제할 수 있다. 메신저/클립보드/백업은 자격 증명 전달 경로다. ‘한 번만 넘기는’ 주석은 기술적 일회성 보장이 아니다.
- **초대 입력 검증 부족 — 코드 확인 및 위험 추론.** 파서는 필드의 truthy 여부만 확인하고 v·자료형·IP/CIDR·키 길이·개행을 검증하지 않는다(`src/wireguard.js:356-369`). 값이 conf에 직접 삽입되고 주소는 HTTP 목적지가 된다(`src/client/tunnel.js:69-81`, `:150`). 악성 초대는 예상 밖 경로/endpoint/요청 대상을 지정할 수 있고, 개행으로 설정 지시문을 추가하려는 입력도 막지 않는다. 이를 즉시 임의 코드 실행으로 단정할 수는 없으며 WireGuard의 별도 스크립트 허용 설정 등 실행 조건은 미확인이다. 피어 이름도 내부 개행을 제거하지 않아 서버 conf의 주석 경계를 넘을 수 있다(`src/wireguard.js:110`, `:142`).
- **철회가 지연됨 — 코드 확인.** 피어 삭제는 JSON만 수정한다(`src/wireguard.js:151-155`). UI의 ‘더 못 붙는다’와 달리 기존 서비스는 터널 재적용 전까지 피어를 유지할 수 있다(`src/renderer/app.js:1129-1131`). API 키 교체 역시 서버 재시작 전에는 기존 키가 계속 유효하고 클라이언트 저장 키도 자동 갱신되지 않는다(`src/wireguard.js:325-330`, `src/server.js:144-146`).
- **공유 키 누락 시 공개 바인드가 허용됨 — 코드 확인.** share 객체만 있으면 0.0.0.0을 사용하지만 키가 비어 있으면 `--api-key`를 생략한다(`src/server.js:138-146`). API 키용 wg genkey 결과도 성공/길이 검증이 없다(`src/wireguard.js:91`, `:328`). 실패 시 기동을 거부하는 처리가 필요하다. 정상 생성된 키가 현재 비어 있다는 증거는 없다.
- **API 키 노출 경로 — 코드 확인.** 키가 프로세스 명령행에 들어가며(`src/server.js:146-147`), 서버 renderer에는 전체 키가 IPC로 전달된다(`src/wireguard.js:310`, `src/main.js:328`). 화면 마스킹은 renderer 메모리 보호가 아니다. 키 복사와 초대 표시도 가능하다(`src/renderer/app.js:1117`, `:1161`). 반면 클라이언트 상태 이벤트는 키를 제거한다(`src/client/main.js:40-43`, `:97`).
- **로그·진단 공개 경로 — 일부 확인, 유출 자체는 미확인.** 진단의 WireGuard 키 필드는 마스킹하지만 서버 로그는 그대로 포함되고 공개 업로드될 수 있다(`src/main.js:176-190`, `:217`, `:303-309`); 로그 파일 저장도 그대로다(`:289-292`). 자식 인자 출력이나 오류에 키가 들어가는 빌드에서는 여기로 전파될 수 있다. 확인한 현재 본가 소스는 자식 API 키 인자를 제거하므로 ‘현재 자식 로그에 반드시 키가 찍힌다’고 주장할 수 없다(6절).
- **HTTP와 넓은 바인드 — 조건부 위험.** 정상 `10.66.0.1` 경로의 외부 전송은 WireGuard로 암호화된다. 하지만 0.0.0.0 리스너에 다른 LAN 허용 규칙이 있으면 LAN 직접 HTTP로 키와 대화를 보낼 수 있다. 현재 좁은 allow는 다른 allow를 상쇄하지 않는다. 클라이언트 하네스는 API 키를 자식 환경 변수에 넘긴다(`src/harness.js:310-311`); CLI 및 그 로그·환경 접근도 신뢰 경계에 포함된다.

## 6. 놓치기 쉬운 사항과 후속 확인

### Windows 터널 인터페이스와 정책

핸드셰이크는 물리 인터페이스의 암호화 UDP 경로이고, 8080은 복호화 뒤 터널 인터페이스의 TCP 경로다. 두 경로의 허용 조건을 별도로 확인해야 한다. 터널 프로필을 Private으로 바꾸는 것만으로 해결된다고 단정해서는 안 된다. Any 규칙이면 프로필 이름만 바꿀 이유가 없고, 명시적 차단/로컬 규칙 병합 제한은 별도 문제다.

기본 생성 AllowedIPs는 `/24`라 `/0` 전용 킬 스위치 조건에 해당하지 않는다(`src/wireguard.js:124`, `:350`; `src/client/tunnel.js:77`). 다만 검증되지 않은 초대가 subnet을 바꿀 수는 있다. 서버 자신인 `10.66.0.1`에 접근하는 데 IP forwarding·NAT·공유기의 TCP 8080 포트 포워딩은 필요하지 않다. 다른 LAN 기기로 전달하는 구성과 혼동하지 않아야 한다. 작은 TCP 연결도 실패하는 단계에서는 MTU보다 리스너·방화벽·라우팅을 먼저 본다.

### llama-server 라우터의 자식 프로세스

앱이 직접 spawn하는 것은 라우터 하나다(`src/server.js:139-147`). 모델 자식 실행은 설치된 llama.cpp 내부 구현이며 이 저장소의 JS가 인자를 직접 전달하는 것이 아니다.

검토 시점 본가 `tools/server/server-models.cpp`는 `CHILD_ADDR=127.0.0.1`(54행), 예약 API 키 옵션 제거(440-447행), 자식 host/port 덮어쓰기(495-503행), 빈 포트 선택(1076행), 인자 및 환경 복사 후 spawn(1090-1107행)을 수행한다. 따라서 부모의 0.0.0.0:8080 및 API 키가 그대로 모든 자식에 복제된다는 가정은 틀리다. 외부 클라이언트는 부모 8080을 사용하고, 자식의 루프백 임시 포트를 외부에 열 필요가 없다. [본가 현재 소스](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-models.cpp)

현재 unsloth master에서도 같은 패턴을 확인했다: `CHILD_ADDR` 49행, API 키 제거 303행, host/port 지정 362-363행, 인자·환경 복사 및 spawn 1026-1045행. [unsloth 현재 소스](https://github.com/unslothai/llama.cpp/blob/master/tools/server/server-models.cpp)

이들은 변경 가능한 master 자료이며 설치 바이너리와 일치함을 입증하지 않는다. 앱은 MTP 또는 기존 설치 출처에 따라 unsloth를 선택하고 같은 출처면 기존 빌드를 재사용한다(`src/install.js:486-495`). 설치 태그와 해당 커밋 소스를 대조해야 한다. 환경도 부모에서 복사하므로 실제 LLAMA 관련 환경 변수와 빌드의 처리 순서까지 별도로 확인해야 한다. API 키가 자식에서 빠지는 현재 구현만 보고 모든 버전의 로그/환경에서 키가 안전하다고 단정할 수 없다.

### 상태 표시와 생명주기

`state.shared`는 실제 소켓 조회 결과가 아니라 spawn 직전 입력값이다(`src/server.js:145`). 공유 화면의 ‘모든 주소 (터널에서 닿는다)’는 방화벽까지 검사한 결과가 아니다(`src/renderer/app.js:1068-1069`). 키 회전·피어 삭제·endpoint 수정·공유 체크 변경은 저장 상태와 현재 프로세스 상태를 분리해서 표시해야 한다.

서버 stop은 taskkill 완료를 기다리지 않고 child를 null로 만든다(`src/server.js:107-110`, `:187-191`). 즉시 재시작하면 구 프로세스의 포트 점유와 close 이벤트가 새 상태에 간섭할 여지가 있다. 이번 증상의 원인으로 확인되지는 않았지만, 재시작 후 실제 PID·리스너로 확인해야 하는 이유다.

### 후속으로 수집할 읽기 전용 증거 — 이번에는 실행하지 않음

1. 서버: `Get-NetTCPConnection -State Listen -LocalPort 8080`으로 LocalAddress·OwningProcess 확인. 전체 명령행을 공유하면 API 키가 노출될 수 있으므로 마스킹 필요.
2. 양쪽: `Get-NetIPAddress -AddressFamily IPv4`, `Get-NetConnectionProfile`, `Get-NetRoute -AddressFamily IPv4`로 터널 주소·프로필·10.66.0.0/24 경로 확인. 클라이언트는 `Find-NetRoute -RemoteIPAddress 10.66.0.1`로 실제 선택 소스/인터페이스 확인.
3. 서버: `Get-NetFirewallRule -PolicyStore ActiveStore`에서 해당 허용 규칙과 충돌하는 차단 규칙 확인. 관련 `Get-NetFirewallAddressFilter`, `Get-NetFirewallPortFilter`, `Get-NetFirewallApplicationFilter` 및 `Get-NetFirewallProfile`로 주소·포트·프로그램·로컬 규칙 병합 정책을 대조.
4. 양쪽: `wg show <터널명> latest-handshakes`, `wg show <터널명> allowed-ips`, `wg show <터널명> transfer`로 실제 적용 피어와 신선도 확인. 일반 `wg show ... dump`에는 개인 키가 포함될 수 있으므로 원문을 진단 채널에 붙이지 않는다.
5. TCP가 성공한 뒤 `/health`, 인증된 `/models`, `/v1/chat/completions` 순서로 구분해 확인. TCP 연결 실패와 HTTP 인증/모델 오류를 하나의 ‘연결 실패’로 합치지 않는다(`src/client/chat.js:109-138`은 오류를 빈 목록/false로 축약한다).

보고서 외 소스 파일은 변경하지 않았다. 실제 장애 원인 확정에는 위 실행 환경 증거가 남아 있다.
