# Agent Dashboard — 진행 상황 (2026-10-29 기준)

## 실행
- 서버: `node ~/.claude/agent-dashboard/server.js` → http://localhost:7777
  (Claude 세션을 끄면 서버도 꺼짐. 꺼져 있어도 훅은 events/ 에 계속 기록)
- 테스트: `cd ~/.claude/agent-dashboard/test`
  - `node --test hook.test.js` (훅 25개, 임시 폴더 사본으로 실행)
  - `node reducer.test.js ../index.html` (상태 계산 6개)
  - `node render.test.js ../index.html` (화면 5개)

## 구성
- `hook.js`: 전역 훅. 7개 에이전트 + 메인 대화(main) 이벤트를 `events/<세션>.jsonl` 에 append
- `server.js`: 세션 파일 폴링 → SSE, 재연결 이어받기, 보존 정리(최근 30개/7일, 30분 내 수정 파일 보존)
- `index.html`: 카드(main + 에이전트), 타임라인, 이벤트 목록, 세션 필터
- `docs/design.md`: architect 설계 문서(초안, P1~P5)
- 전역 설정 `~/.claude/settings.json` hooks: SubagentStart, SubagentStop, PreToolUse,
  PostToolUse, PostToolUseFailure, SessionEnd(동기), UserPromptSubmit, Stop
  (백업: settings.json.bak, .bak2, .bak3)

## 완료
- P1 재연결 중복 방지 (epoch-seq id, Last-Event-ID)
- P2 세션별 로그 파일, 서버만 정리
- P3 순서 무관 상태 계산, SessionEnd 중단 / 15분 응답 없음
- P4 Host/Origin 검사, /clear X-Dashboard 헤더, CSP
- P5 세션 필터, 동시 실행 표시, /agents, 바뀐 부분만 다시 그리기
- 메인 대화(main) 카드: UserPromptSubmit=턴 시작, Stop=응답 완료

## 남은 일 (reviewer "수정 후 승인" 필수 항목)
1. `/clear` 가 세션 파일을 삭제함 → 파일은 두고 clearedAt 을 state.json 에 저장, 그 이전 이벤트만 숨기기
2. 저장한 세션 필터가 새로고침마다 풀림 → 첫 데이터 전 render() 에서 selected 를 지우지 말 것 (index.html renderSessions)
3. 20MB 초과 시 SubagentStart/Stop/SessionEnd 까지 막음 → 도구 이벤트만 막기 (hook.js append)
4. 기록 지우기 후 브라우저가 직접 상태를 비움 → 서버 reset 만 따르기 (index.html clear onclick)

## 결정 필요
- P1 한계: 서버 버퍼 5000건 밖의 실행은 새로고침 시 틀리게 복원됨
  → (a) 한계 수용 후 design.md 에 기록 / (b) 서버가 상태를 들고 스냅샷 전송
- design.md 를 "확정"으로 바꿀지 (architect 열린 질문 Q1~Q3 은 사실상 답이 정해짐: SessionEnd 추가함, 보존값 그대로, 기존 로그는 이관)

## 그 밖 (낮음)
- 훅/서버 오류를 조용히 삼킴 → hook-errors.log
- 브라우저 runs/calls 상한 없음, tool_use_id 없을 때 짝 안 맞음, 세션 드롭다운이 갱신 때 닫힘
- events.jsonl.migrated 는 확인 후 삭제해도 됨

## 별도
- 사이드 패널 mod `agent-monitor` (터미널 패널 버전)
  → `plugin/agent-monitor/` 에 있음. `claude --plugin-dir ~/.claude/agent-dashboard/plugin/agent-monitor` 로 로드
