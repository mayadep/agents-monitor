# Agent Dashboard v2 설계 (정합성·재연결·동시 세션·보존 정책)

> 상태: 초안
> 작성: architect 에이전트 · 날짜: 2026-10-28
> 이 문서가 구현의 유일한 근거다. 여기 없는 내용은 구현자가 판단으로 채우지 않는다.
> 대상 폴더: `~/.claude/agent-dashboard/` (이하 `DASH/`). Node v24.21.0, 외부 의존성 없음.

## 0. 현재 구조 요약과 약점 (근거)

현재 흐름: Claude Code 훅(SubagentStart/Stop, Pre/PostToolUse, PostToolUseFailure, 모두 `async: true`, matcher `*`)
→ `node hook.js` (이벤트마다 새 프로세스) → `DASH/events.jsonl` 에 한 줄 append
→ `server.js` 가 300ms 폴링으로 증가분을 읽어 SSE 브로드캐스트 → `index.html` 이 클라이언트 측에서 상태 재구성.

| # | 분류 | 약점 | 근거 |
|---|---|---|---|
| W1 | 재연결 중복 | EventSource 자동 재연결 시 서버가 최근 3000줄을 다시 보내고, 클라이언트는 기존 상태를 비우지 않고 `apply` 한다. 피드 중복, `r.count`(도구 호출 수) 2배, trail 중복. 이벤트에 id 가 없어 중복 제거 불가. | server.js `/events` 의 `send(res, readAll().slice(-3000))`; index.html `es.onopen` 에서 상태 초기화 없음 |
| W2 | 스냅샷/테일 경합 | 연결 시 `readAll()` 은 파일 끝까지 읽지만 폴러의 `offset` 은 최대 300ms 뒤처질 수 있다. 그 사이 추가된 줄은 스냅샷과 다음 폴링 양쪽에서 전송된다. | server.js `readAll` 과 `offset` 이 독립 |
| W3 | 로그 회전 경합 | 각 훅 프로세스가 `statSync > 5MB` 이면 `writeFileSync(LOG,'')` 로 truncate. 동시 훅 사이에서 다른 프로세스가 막 쓴 줄이 지워질 수 있고, 회전 시 진행 중 run 의 SubagentStart 를 포함한 전체 이력이 사라진다. 서버는 `size < offset` 으로만 감지하므로 truncate 후 300ms 안에 old offset 이상으로 다시 자라면 감지 실패, 파일 중간부터 읽어 깨진 JSON 을 보낸다. | hook.js 회전 블록, server.js `size < offset` |
| W4 | 비동기 훅 순서 | `async: true` 훅은 프로세스별로 완료 순서가 보장되지 않고, `ts` 는 node 기동 후 찍힌다. Post 가 Pre 보다 먼저 기록될 수 있다. 그러면 `r.tool` 이 영구히 남고, Stop 뒤에 늦게 온 PreToolUse 가 run 을 다시 `running` 으로 되살린다. | index.html `apply` 의 `PreToolUse` 분기(`if (r.status !== 'running') r.status='running'`), `PostToolUse` 의 `r.tool === e.tool` 비교 |
| W5 | 병렬 도구 호출 | 한 에이전트가 같은 메시지에서 도구를 병렬 호출하면 `tool_use_id` 를 기록하면서도 쓰지 않아, 실패 표시가 "마지막 trail" 에 붙고 현재 도구 표시가 틀린다. | index.html `trail[trail.length-1].failed = true` |
| W6 | 종료 감지 없음 | 세션 강제 종료(Ctrl+C, 크래시) 시 SubagentStop 이 오지 않아 run 이 영원히 "실행" 으로 남는다. 실패 상태(`failed`) CSS 는 있지만 run 을 failed 로 만드는 경로가 없다. | index.html `LABEL.failed` 존재, `apply` 에 진입 경로 없음 |
| W7 | 동시 세션 | 여러 Claude Code 세션이 같은 파일에 쓰고 `session` 필드도 기록하지만 UI 는 무시한다. 카드는 세션 구분 없이 타입별 최신 run 하나만 보여주고, 같은 타입 동시 실행(예: implementer 2개)은 하나만 보인다. | index.html `render` 의 `mine[mine.length-1]` |
| W8 | 서버 크래시 | 폴링 콜백에서 `stat` 과 `openSync` 사이에 파일이 지워지거나 잠기면(Windows EBUSY/ENOENT) `openSync` 예외가 setInterval 밖으로 던져져 프로세스가 죽는다. | server.js 폴링 블록, try 범위 밖 `openSync` |
| W9 | UTF-8 분할 | 증가분을 `buf.toString('utf8')` 후 문자열로 줄을 자른다. 쓰기 도중 읽혀 멀티바이트 문자(한글 입력 요약) 중간에서 끊기면 U+FFFD 로 깨진다. | server.js `partial + buf.toString('utf8')` |
| W10 | 성능 | 새 연결마다 최대 5MB 파일을 동기로 통째로 읽어 이벤트 루프를 막는다. 클라이언트는 running run 이 있으면 500ms 마다 카드·타임라인·피드 200줄 innerHTML 전체를 재생성(스크롤/선택/툴팁 깨짐). 훅은 모든 세션의 모든 도구 호출(메인 스레드 포함)마다 node 프로세스를 띄운다(비동기라 지연은 없지만 CPU 비용). | server.js `readAll`, index.html `setInterval(render)` |
| W11 | 보안 | `POST /clear` 에 Origin/Host 검사가 없다. 아무 웹 페이지나 `fetch('http://127.0.0.1:7777/clear',{method:'POST',mode:'no-cors'})` 로 기록을 지울 수 있다(단순 요청이라 preflight 없음). DNS rebinding 으로 `/events`(명령어, 파일 경로) 열람도 가능. | server.js 라우팅 |
| W12 | 중복 정의 | 에이전트 목록이 `~/.claude/agents/*.md`(훅) 와 index.html `AGENTS` 상수에 이중 정의. 에이전트 추가 시 drift. 훅의 오류는 전부 `catch {}` 로 삼켜져 진단 불가. | hook.js `globalAgents`, index.html `AGENTS` |

## 1. 목적과 범위
- 해결할 문제: 위 W1~W12 중 데이터 정합성(W1~W6), 동시 세션(W7), 서버 견고성·보안(W8, W9, W11), 성능(W10 일부), 중복 정의(W12).
- 포함:
  - 개선안 P1~P5 (아래 우선순위 순). P1~P4 는 이번 범위, P5 는 P1~P4 완료 후 같은 문서 기준으로 진행.
  - P1 (최우선) 서버 단일 시퀀서 + 공유 리듀서 + 스냅샷/`Last-Event-ID` 재개 프로토콜 → W1, W2, W10(서버)
  - P2 세션별 로그 파일 + 서버 소유 보존 정책(훅은 절대 truncate/삭제 안 함) → W3, W7(저장)
  - P3 순서 비의존 리듀서(`tool_use_id` 기준, 종료 상태 불가역) + 종료 감지(SessionEnd, stale) → W4, W5, W6
  - P4 서버 견고성·보안(바이트 단위 줄 분리, 예외 격리, Host/헤더 검사) → W8, W9, W11
  - P5 UI·성능(세션 필터, 같은 타입 동시 실행 표시, 섹션별 dirty 렌더, 에이전트 목록 서버 제공) → W7(UI), W10(클라이언트), W12
- 비목표:
  - 기존 `events.jsonl` 데이터 마이그레이션 (가정 A3).
  - 인증/원격 접속 지원 (127.0.0.1 전용 유지).
  - 훅을 상주 데몬/소켓 방식으로 바꾸는 것 (대안 비교 6장 D2 참고).
  - 프레임워크·빌드 도구·npm 의존성 도입.

### 가정
- A1. 훅 입력 JSON 에는 `hook_event_name, session_id, cwd, agent_id, agent_type, tool_name, tool_use_id, tool_input, last_assistant_message` 가 현재 코드가 기대하는 대로 들어온다. 이벤트 발생 시각 필드는 없다. 따라서 `ts` 는 훅 프로세스 시각이며 수십~수백 ms 지터가 있다.
- A2. Windows 에서 `fs.appendFileSync`(flag `a`) 는 `FILE_APPEND_DATA` 로 열려 단일 WriteFile 호출 단위로 끝에 붙는다. 한 줄을 2048 바이트 이하로 제한하면 줄 단위 원자성을 사실상 보장한다고 본다.
- A3. 기존 `DASH/events.jsonl` 은 디버그용이며 버려도 된다. v2 서버는 읽지 않는다.
- A4. Claude Code 는 `SessionEnd` 훅 이벤트를 지원하고 입력에 `session_id`, `reason` 이 있다. (열린 질문 Q1: settings.json 변경 승인 필요)
- A5. 대시보드 서버는 한 번에 하나만 실행된다(포트 7777 단일).

## 2. 모듈 구조
| 모듈/파일 | 신규·변경 | 책임 | 의존 |
|---|---|---|---|
| `DASH/hook.js` | 변경 | 훅 입력 필터링, v2 레코드 생성, `DASH/events/<session>.jsonl` 에 한 줄 append. truncate/삭제 금지. 오류는 `DASH/hook-errors.log` 에 한 줄 기록(크기 1MB 초과 시 기록 생략) | `fs, path, os, crypto` |
| `DASH/reducer.js` | 신규 | 순수 상태 리듀서. Node(`module.exports`)와 브라우저(`globalThis.AgentReducer`) 양쪽에서 동일 코드 사용 | 없음 |
| `DASH/server.js` | 변경 | 세션 파일 tail(바이트 단위), 전역 seq 부여, 상태 유지(`reducer.js`), 링 버퍼, SSE 스냅샷/재개, 보존 정책, `/clear`, 정적 파일, Host/헤더 검사 | `fs, http, path, os, crypto`, `./reducer.js` |
| `DASH/index.html` | 변경 | 스냅샷 수신 후 상태 교체, seq 로 중복 무시, `reducer.js` 로 적용, 세션 필터, 섹션별 렌더 | `/reducer.js` |
| `DASH/test/reducer.test.js` | 신규 | `node --test` 로 리듀서 규칙 검증 | `node:test, node:assert`, `../reducer.js` |
| `DASH/test/tail.test.js` | 신규 | 서버 tail 함수(바이트 분할, 부분 줄, 파일 축소) 검증 | `node:test, node:assert`, `../server.js` 의 export |
| `DASH/events/` | 신규(런타임 데이터) | 세션별 jsonl. 훅이 생성, 서버가 보존 정책으로 삭제 | - |
| `DASH/state.json` | 신규(런타임 데이터) | `{ "clearedAt": <ms> }` 영속화 | - |
| `~/.claude/settings.json` | 변경(Q1 승인 시) | `SessionEnd` 훅 등록 (기존 5개 항목과 같은 형태: matcher `*`, command 동일, async true, timeout 10) | - |

## 3. 인터페이스

### 3.1 이벤트 레코드 v2 (hook.js 가 쓰는 한 줄)
```ts
type HookRecord = {
  v: 2,
  eid: string,            // crypto.randomUUID()
  ts: number,             // hook.js 최상단에서 캡처한 Date.now()
  event: 'SubagentStart'|'SubagentStop'|'PreToolUse'|'PostToolUse'|'PostToolUseFailure'|'SessionEnd',
  session: string,        // session_id 원본
  cwd?: string,           // e.cwd, 160자 cut
  agent_id?: string,
  agent_type?: string,
  tool?: string,
  tool_use_id?: string,
  input?: string,         // PreToolUse 에만. 기존 summarize() 그대로 (160자)
  failed?: true,          // PostToolUseFailure 에만
  message?: string,       // SubagentStop 에만. 300자 cut
  reason?: string,        // SessionEnd 에만
}
```
- 직렬화 결과가 2048 바이트를 넘으면 `input`, `message`, `cwd` 순으로 제거하고 다시 직렬화한다.
- 파일 경로: `DASH/events/<safe(session)>.jsonl`, `safe = s => (s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)`.

### 3.2 hook.js 필터 규칙 (순서대로)
```js
const AGENT_EVENTS = new Set(['SubagentStart','SubagentStop','PreToolUse','PostToolUse','PostToolUseFailure'])
function shouldRecord(e, agents /* Set<string> */, sessionFileExists /* boolean */): boolean
```
1. `event === 'SessionEnd'` → `sessionFileExists` 일 때만 true (에이전트를 쓰지 않은 세션은 파일을 만들지 않는다).
2. `!AGENT_EVENTS.has(event)` → false.
3. Lifecycle 이 아니고 `!e.agent_id` → false.
4. `!agents.has(e.agent_type)` → false.
5. 그 외 true.
- `PER_FILE_MAX = 20 * 1024 * 1024`. 파일이 이보다 크면 `PreToolUse/PostToolUse/PostToolUseFailure` 는 기록하지 않고 Lifecycle/SessionEnd 만 기록한다.
- 모든 예외: `hook-errors.log` 에 `${new Date().toISOString()} ${err.message}\n` 한 줄. 이 쓰기의 예외는 무시.

### 3.3 reducer.js
```js
// UMD: if (typeof module === 'object') module.exports = api; else globalThis.AgentReducer = api
const LIMITS = { FEED_MAX: 200, TRAIL_MAX: 30, CLOSED_MAX: 64, RUNS_MAX: 300 }

/** @returns {State} */
function createState()
// State = { runs: { [runKey: string]: Run }, sessions: { [session: string]: Session }, feed: ServerEvent[] }

/** 순수하지 않음: state 를 제자리 변경한다. 바뀌면 영향 섹션 집합 반환 */
function applyEvent(state, ev /* ServerEvent */) /* -> { runs: boolean, feed: boolean } */

/** 렌더 시점 계산. 저장하지 않는다 */
function displayStatus(run, now /* ms */, staleMs /* = 15*60*1000 */)
  /* -> 'running'|'stale'|'completed'|'aborted' */

function runKey(session, agentId) /* -> `${session}:${agentId}` */
```
타입:
```ts
type ServerEvent = HookRecord & { seq: number }        // seq 는 서버가 부여
type Run = {
  key: string, session: string, agentId: string, type: string,
  status: 'running'|'completed'|'aborted',
  start: number, end: number|null, lastTs: number,
  count: number, failCount: number,
  pending: { [tool_use_id: string]: { tool: string, input?: string, ts: number } },
  closed: string[],               // 최근 완료된 tool_use_id, CLOSED_MAX 개
  trail: { id: string, tool: string, failed: boolean }[],   // TRAIL_MAX 개
  message: string|null,
}
type Session = { id: string, cwd: string|null, first: number, last: number, ended: boolean }
```
리듀서 규칙 (모든 규칙은 이벤트 도착 순서와 무관하게 같은 결과를 내야 한다. 단 trail 순서는 도착 순):
- 공통: `ev.session` 으로 Session upsert (`first=min`, `last=max`, `cwd` 는 처음 받은 non-empty 값). feed 에 push, FEED_MAX 초과분 앞에서 제거.
- `SessionEnd`: session.ended = true. 해당 세션의 `status==='running'` run 전부 `status='aborted'`, `end = ev.ts`.
- 그 외 이벤트에 `agent_id` 없으면 run 처리 없음.
- run 없으면 생성: `status='running', start=ev.ts, end=null, lastTs=ev.ts, type=ev.agent_type||'unknown'`. 생성 직후 세션이 `ended` 면 `status='aborted', end=ev.ts`.
- 모든 run 이벤트: `start=min(start, ev.ts)`, `lastTs=max(lastTs, ev.ts)`, type 이 'unknown' 이고 ev.agent_type 있으면 교체.
- `SubagentStart`: 상태 변경 없음(위 공통만).
- `PreToolUse`: `closed` 에 `tool_use_id` 가 있으면 trail/count 만 반영하고 pending 에 넣지 않는다. 없으면 `pending[id] = {tool, input, ts}`. `count++`, trail push `{id, tool, failed:false}`. **status 는 바꾸지 않는다.**
- `PostToolUse` / `PostToolUseFailure`: `delete pending[id]`, `closed` 에 id push(CLOSED_MAX 초과 시 앞 제거). failed 면 `failCount++` 이고 trail 에서 `t.id === id` 인 항목을 `failed=true`. 해당 trail 항목이 아직 없으면(Post 선착) 아무것도 하지 않음 — 이후 Pre 가 오면 `closed` 에 있으므로 failed 를 알 수 없음 → 이를 위해 `closed` 원소를 `{id, failed}` 로 저장하고 Pre 처리 시 그 값으로 trail 항목 failed 를 설정한다. (Run.closed 타입은 `{id:string, failed:boolean}[]` 로 확정)
- `SubagentStop`: `status='completed'`(이미 `aborted` 면 `completed` 로 덮어씀: Stop 이 실제 종료 증거이므로), `end=max(end??0, ev.ts)`, `pending={}`, `message=ev.message??null`.
- 종료 상태(`completed`, `aborted`)에서 Pre/Post 가 와도 status 는 되돌리지 않는다. 새 run 은 오직 새 `agent_id` 로만 생긴다.
- RUNS_MAX 초과 시 `status!=='running'` 인 run 중 `start` 가 가장 오래된 것부터 삭제.
- `displayStatus`: `status==='running' && now - lastTs > staleMs` → `'stale'`, 그 외 status 그대로.

### 3.4 server.js
```js
// 상수
const PORT = Number(process.argv[2]) || 7777
const EVENTS_DIR = path.join(__dirname, 'events')
const POLL_MS = 300, RING_MAX = 5000, PING_MS = 15000
const RETAIN_FILES = 30, RETAIN_DAYS = 7, ACTIVE_GRACE_MS = 30 * 60 * 1000, SWEEP_MS = 60 * 60 * 1000
const BOOT = crypto.randomBytes(4).toString('hex')

// 테스트용 export (require.main !== module 이면 listen 하지 않는다)
module.exports = { createTailer, readNew }

/** 파일별 tail 상태 */
function createTailer(file) // -> { file, offset: 0, rem: Buffer(0) }

/**
 * 증가분을 바이트 단위로 읽어 완성된 줄만 반환.
 * - size < offset: offset=0, rem 비움, 처음부터 다시 (truncate 대응; v2 에선 정상 경로에서 발생하지 않음)
 * - 0x0A 기준으로 Buffer 에서 분리한 뒤 줄마다 toString('utf8')
 * - ENOENT/EBUSY/EPERM: [] 반환, 상태 유지
 */
function readNew(tailer) // -> string[]

/** 줄 → ServerEvent. JSON 오류, v!==2, ts < clearedAt 이면 null */
function ingestLine(line) // -> ServerEvent|null  (seq = ++lastSeq, ring push, applyEvent, broadcast)
```
HTTP:
| 메서드 경로 | 동작 |
|---|---|
| `GET /` , `/index.html` | index.html |
| `GET /reducer.js` | `application/javascript; charset=utf-8` |
| `GET /events` | SSE. 아래 프로토콜 |
| `POST /clear` | 헤더 `X-Dashboard: 1` 필수(없으면 403). `clearedAt=Date.now()` 을 `state.json` 에 기록, `state=createState()`, ring 비움, 모든 클라이언트에 snapshot 전송. 파일은 지우지 않는다. 204 |
| 기타 | 404 |
- 모든 요청: `Host` 가 `localhost:${PORT}` 또는 `127.0.0.1:${PORT}` 가 아니면 403 (DNS rebinding 방지).

SSE 프로토콜:
```
retry: 2000

event: snapshot
id: <BOOT>:<lastSeq>
data: {"boot":"<BOOT>","seq":<lastSeq>,"agents":["architect",...],"staleMs":900000,"state":<State>}

id: <BOOT>:<seq>
data: <ServerEvent JSON>

: ping
```
- 연결 시 `Last-Event-ID` 헤더 파싱 `boot:seq`.
  - `boot === BOOT` 이고 `ring.length>0 && seq >= ring[0].seq - 1` (또는 ring 이 비고 `seq === lastSeq`) → ring 에서 `seq` 초과 이벤트만 전송.
  - 그 외 → snapshot 전송.
- `agents` 는 `~/.claude/agents/*.md` 를 snapshot 마다 readdir.
- `res.write` 실패/`'error'` → 클라이언트 제거.

시작 순서: `state.json` 로드 → 보존 sweep → `events/` 의 모든 파일을 전부 읽어 줄 수집 → `ts` 오름차순 안정 정렬 → 순서대로 `ingestLine` (broadcast 없음) → 각 파일 tailer offset = 읽은 바이트 → listen → 폴링 시작.

폴링(POLL_MS): `readdir(EVENTS_DIR)` 로 새 파일 tailer 추가, 각 tailer `readNew` → `ingestLine`. 전체 콜백을 try/catch 로 감싸고 오류는 `console.error` 후 다음 주기 계속. 동기 fs 사용 허용(파일당 증가분만 읽음).

보존 sweep: 파일을 mtime 내림차순 정렬. `now - mtime < ACTIVE_GRACE_MS` 면 유지. 그 외 `index >= RETAIN_FILES` 또는 `now - mtime > RETAIN_DAYS` 이면 `unlinkSync`, 실패(EBUSY/EPERM)는 무시하고 다음 sweep 에 재시도. 삭제한 파일의 tailer 제거. 메모리 state 는 건드리지 않는다(RUNS_MAX 로 이미 상한).

### 3.5 index.html 클라이언트
```js
let state = AgentReducer.createState(), lastSeq = 0, boot = null, agents = [], staleMs = 900000
let dirty = { runs: true, feed: true }
let sessionFilter = 'all'   // 'all' | session id. localStorage 'dash.session' 에 저장
```
- `es.addEventListener('snapshot', m => { const s = JSON.parse(m.data); state = s.state; lastSeq = s.seq; boot = s.boot; agents = s.agents; staleMs = s.staleMs; dirty = {runs:true, feed:true} })`
- `es.onmessage`: `ev.seq <= lastSeq` 면 무시. 아니면 `const d = AgentReducer.applyEvent(state, ev); lastSeq = ev.seq;` d 로 dirty 갱신.
- `reset` 이벤트 핸들러 삭제(snapshot 으로 대체). `/clear` 호출은 `fetch('/clear', {method:'POST', headers:{'X-Dashboard':'1'}})` 이고 로컬 상태는 직접 지우지 않는다(서버 snapshot 을 기다림).
- `AGENTS` 상수 삭제. 카드 타입 목록 = `agents` ∪ 관측된 run.type.
- 렌더: 1초 타이머는 running/stale 카드의 경과시간 텍스트와 타임라인만 갱신. 피드는 `dirty.feed` 일 때만 재생성. 카드 HTML 은 `dirty.runs` 이거나 1초 타이머일 때.
- 카드: 필터된 run 중 해당 타입. 표시 run 우선순위 = `running/stale` 중 최신 start, 없으면 전체 최신 start. 메타에 `실행 중 N` (N≥2 일 때만) 추가. 현재 도구 = 표시 run 의 `pending` 중 ts 가 가장 늦은 항목, 여러 개면 `+k` 표기.
- 상태 라벨: `{ idle:'대기', running:'실행', stale:'응답 없음', completed:'완료', aborted:'중단' }`. CSS `.card.stale`(`--idle` 점선 상단), `.card.aborted`(`--fail`).
- 세션 필터 `<select>`: 옵션 = `state.sessions` 를 `last` 내림차순, 라벨 `basename(cwd) · id 앞 8자 · HH:MM`. 헤더 통계도 필터 적용.

## 4. 데이터 흐름
1. Claude Code 가 훅 이벤트 발생 → `node hook.js` (async). 최상단에서 `ts` 캡처.
2. hook.js: stdin JSON 파싱 → `shouldRecord` → v2 레코드 생성(2048B 제한) → `events/<session>.jsonl` 에 `appendFileSync` 1회. (`events/` 없으면 `mkdirSync({recursive:true})`)
3. server.js 폴러: 파일별 tailer 가 바이트 증가분을 읽고 완성 줄만 반환. 남은 바이트는 `tailer.rem` 에 보관.
4. `ingestLine`: 파싱/검증 → `seq=++lastSeq` → ring push(RING_MAX) → `applyEvent(serverState, ev)` → 모든 클라이언트에 `id: BOOT:seq` 로 전송. **seq 부여와 상태 반영과 전송이 한 동기 블록에서 일어나므로 스냅샷과 실시간 사이에 틈이나 중복이 없다.**
5. 새 연결: `Last-Event-ID` 로 ring 재개 가능하면 delta, 아니면 그 순간의 `serverState` 와 `lastSeq` 를 snapshot 으로 전송 후 clients 에 등록 (같은 동기 블록).
6. 클라이언트: snapshot 이면 상태 교체, 일반 이벤트는 `seq > lastSeq` 일 때만 동일 리듀서로 적용 → 섹션별 렌더.
7. `/clear`: 서버 state·ring 초기화 + `clearedAt` 영속화 → 전체 snapshot. 재시작 시에도 `ts < clearedAt` 이벤트는 무시.
8. 보존: 시작 시 + SWEEP_MS 마다 서버가 오래된 세션 파일 삭제. 훅은 삭제/truncate 하지 않는다.
- 상태 저장 위치: 영속 = `events/*.jsonl`, `state.json`. 휘발 = 서버 `serverState`, `ring`, `lastSeq`, tailer offset. 클라이언트 `state` 는 서버 상태의 복제본.

## 5. 하지 말아야 할 것
- hook.js 에서 로그 파일을 truncate, rename, delete 하지 않는다. 파일 수명 관리는 서버만 한다.
- 클라이언트에서 재연결 시 "상태를 비우고 다시 받기" 로 W1 을 해결하지 않는다. 반드시 snapshot + seq 비교로 해결한다(깜빡임과 이중 적용 방지).
- 리듀서 로직을 index.html 과 server.js 에 각각 복사하지 않는다. `reducer.js` 하나만 둔다.
- `PreToolUse` 수신으로 run 의 status 를 `running` 으로 되돌리지 않는다.
- 현재 도구 해제를 `tool` 이름 비교로 하지 않는다. 반드시 `tool_use_id` 로 한다.
- 버퍼를 `toString('utf8')` 한 뒤 줄을 자르지 않는다. 0x0A 로 Buffer 를 먼저 자른다.
- 이벤트 정렬/중복 제거에 `ts` 를 쓰지 않는다(시작 시 초기 적재 정렬만 예외). 실시간 순서와 중복 판단은 `seq` 만 쓴다.
- `fs.watch` 단독 의존 금지. 폴링을 기본으로 둔다(Windows 신뢰성).
- `/clear` 에서 세션 파일을 지우지 않는다(훅이 쓰는 중인 파일 EBUSY, 다른 세션 데이터 손실).
- npm 의존성, 번들러, 프레임워크 추가 금지. `Access-Control-Allow-Origin` 헤더 추가 금지.
- `catch {}` 로 오류를 조용히 삼키지 않는다. 훅은 `hook-errors.log`, 서버는 `console.error`.
- settings.json 은 Q1 승인 전에는 수정하지 않는다.

## 6. 결정 기록
| 결정 | 검토한 대안 | 선택 이유 |
|---|---|---|
| D1 재연결 중복 해결: 서버 seq + 공유 리듀서 + snapshot/`Last-Event-ID` 재개 | (a) 클라이언트 `onopen` 시 상태 초기화 후 서버가 매번 3000줄 재전송: 변경 최소, 그러나 W2 경합 잔존, 3000줄 밖 SubagentStart 유실, 재연결마다 깜빡임과 5MB 동기 읽기. (b) 줄 byte offset 을 id 로 사용: 파일이 여러 개(P2)가 되면 단일 id 불가. (c) 채택안 | 경합이 구조적으로 사라지고(단일 동기 블록), 스냅샷이 줄 수가 아닌 상태라 오래된 run 도 정확. 복잡도 중간(리듀서 모듈 1개 추가) |
| D2 저장 구조: 세션별 파일 + 서버 소유 보존 | (a) 단일 파일 유지 + 서버가 rename 회전(`events.1.jsonl`): 파일 1개라 단순하나 Windows 에서 훅이 연 순간 rename EBUSY, 회전 경계에서 run 분리, 세션 간 혼재 지속. (b) 훅 → 상주 서버로 HTTP POST: 파일 경합 0, 그러나 서버가 꺼져 있으면 이벤트 유실, 훅 실패 처리 필요. (c) 채택안 | 활성 파일을 절대 건드리지 않고 세션 단위로 깔끔히 만료. 서버가 꺼져 있어도 기록 유지. 비용: 서버 다중 파일 tail(파일 수 ≤ 30 수준이라 무시 가능) |
| D3 순서 비의존 리듀서 | (a) 서버가 ts 로 짧은 지연 버퍼(예: 500ms) 후 정렬 방출: 지연 증가, 지터가 버퍼보다 크면 여전히 오류. (b) 채택안: tool_use_id 매칭 + 종료 상태 불가역 + closed 목록 | 도착 순서와 무관하게 수렴. 실시간성 유지 |
| D4 종료 감지: SessionEnd 훅 + 렌더 시 stale 계산 | (a) stale 만: 설정 변경 없음, 그러나 15분간 "실행" 오표시. (b) SessionEnd 만: 크래시 시 이벤트 없음 | 둘을 병행해야 정상 종료와 크래시 모두 커버. SessionEnd 는 Q1 승인 필요, 미승인 시 stale 만으로 동작 |
| D5 보안: Host 검사 + `/clear` 커스텀 헤더 | (a) 토큰 쿼리 파라미터: 페이지에 토큰 주입 필요. (b) 채택안 | 커스텀 헤더는 교차 출처에서 preflight 를 강제하고 서버는 CORS 를 허용하지 않으므로 차단됨. 구현 몇 줄 |
| D6 우선순위 P1>P2>P3>P4>P5 | 보안(P4) 선행 | P1 은 매 재연결마다 눈에 보이는 수치 오류(사용자 체감 버그). P4 의 W8 크래시는 P2 구현에서 tail 함수를 새로 쓰며 자연히 해소되므로 P2 와 함께 진행 |

### 개선안 요약 (우선순위·트레이드오프)
| 우선 | 개선안 | 해결 | 얻는 것 | 비용/트레이드오프 |
|---|---|---|---|---|
| P1 | 서버 seq + 공유 리듀서 + snapshot/재개 | W1, W2, W10(서버) | 재연결 중복·카운트 2배 제거, 연결 시 파일 전체 읽기 제거 | 리듀서 모듈 신설, 서버가 상태를 메모리 보유(RUNS_MAX 300 으로 상한) |
| P2 | 세션별 파일 + 서버 보존 정책 | W3, W7(저장), W8 | truncate 경합·이력 증발 제거, 세션 단위 만료 | 다중 파일 tail, 기존 events.jsonl 미이관 |
| P3 | 순서 비의존 리듀서 + SessionEnd/stale | W4, W5, W6 | 늦게 도착한 이벤트로 인한 부활·고착 제거, 중단 run 표시 | settings.json 변경 필요(Q1), stale 임계값은 휴리스틱 |
| P4 | 바이트 단위 tail, 예외 격리, Host/헤더 검사 | W8, W9, W11 | 서버 크래시·한글 깨짐·외부 페이지 삭제 차단 | 거의 없음 |
| P5 | 세션 필터, 동시 실행 표시, 섹션별 렌더, 에이전트 목록 서버 제공 | W7(UI), W10, W12 | 다중 세션 가독성, 렌더 비용 감소, drift 제거 | UI 코드 증가. 훅의 매 도구 호출 node 기동 비용은 이번에 줄이지 않음(D2-b 대안 필요) |

## 7. 구현 단계
| 단계 | 내용 | 완료 조건 (테스트/검증) |
|---|---|---|
| 1 | `reducer.js` 작성 (3.3 전 규칙) | `node --test DASH/test` 에서 reducer.test.js 통과. 필수 케이스: (a) Pre→Post 와 Post→Pre 두 순서 모두 pending 비어 있음 (b) Stop 후 Pre 도착 시 status==='completed' (c) 병렬 Pre(id1,id2)→Failure(id1) 시 trail 의 id1 만 failed (d) Post(Failure) 선착 후 Pre → trail 항목 failed=true (e) SessionEnd 시 running→aborted, Stop 이 뒤에 오면 completed (f) feed ≤ 200, trail ≤ 30, runs ≤ 300 (g) displayStatus stale 판정 |
| 2 | `hook.js` v2: 레코드 스키마, 세션별 파일, shouldRecord, 2048B 제한, truncate 제거, 오류 로그 | 샘플 stdin JSON 6종(각 이벤트)을 `node hook.js < sample.json` 으로 넣어 `events/<session>.jsonl` 에 v2 줄이 생기는지 확인. 에이전트 미등록 타입·agent_id 없는 PreToolUse 는 기록 안 됨. 파일 없는 세션의 SessionEnd 는 파일 생성 안 함. 10KB 입력도 줄 ≤ 2048B. hook.js 에 `writeFileSync(` / `unlinkSync(` / `renameSync(` 가 없음(grep) |
| 3 | `server.js` tail·ingest: `createTailer`, `readNew`, 초기 적재, 폴링, 예외 격리 | tail.test.js 통과: (a) 한글 3바이트 문자 중간에서 끊긴 두 번의 쓰기 → 한 줄 정상 복원 (b) 줄바꿈 없는 꼬리는 다음 호출까지 보류 (c) 파일 축소 시 처음부터 (d) 파일 삭제 시 [] 반환·예외 없음 |
| 4 | SSE 프로토콜: snapshot, id, Last-Event-ID 재개, ring, `/reducer.js`, Host 검사, `/clear` 헤더·clearedAt | `curl -N -H "Host: localhost:7777" localhost:7777/events` 첫 프레임이 `event: snapshot`. `-H "Last-Event-ID: <BOOT>:<n>"` 재연결 시 snapshot 없이 seq>n 만 수신. 다른 boot id → snapshot. `Host: evil.com` → 403. 헤더 없는 `POST /clear` → 403, 헤더 있으면 204 후 모든 연결에 snapshot |
| 5 | `index.html`: snapshot 처리, seq 중복 무시, reducer 사용, 라벨/CSS 추가, AGENTS 상수 제거 | 서브에이전트 실행 중 서버를 재시작하고 브라우저 재연결 후 도구 호출 수가 재시작 전과 동일. 개발자도구 Network 에서 재연결(오프라인 토글) 후 피드 중복 행 0 |
| 6 | 보존 sweep (시작 + 매시간) | `events/` 에 mtime 을 8일 전으로 바꾼 파일과 31개 이상 파일을 만들어 서버 시작 → 조건에 맞는 파일만 삭제, 30분 이내 수정 파일은 유지 |
| 7 | (Q1 승인 시) settings.json 에 SessionEnd 훅 등록 | 서브에이전트 실행 중 세션 종료 → 해당 run 이 '중단' 표시. 미승인 시 이 단계 생략, 15분 무이벤트 run 은 '응답 없음' 표시로 확인 |
| 8 | P5 UI: 세션 필터, 동시 실행 N, 섹션별 dirty 렌더 | 두 세션에서 동시에 에이전트 실행 시 필터별 카드·통계가 분리됨. 같은 타입 2개 동시 실행 시 `실행 중 2` 표시. 피드 스크롤 위치가 새 이벤트 없을 때 유지 |

## 8. 열린 질문
- Q1. `~/.claude/settings.json` 에 `SessionEnd` 훅을 추가해도 되는가? (전역 설정 변경이라 사용자 승인 필요. 미승인 시 D4 는 stale 표시만으로 동작)
- Q2. 보존 정책 값(최근 30개 세션 파일, 7일, stale 15분)이 사용 패턴에 맞는가?
- Q3. 기존 `events.jsonl` 을 버려도 되는가(A3)? 보존이 필요하면 1회성 변환 단계를 추가한다.
