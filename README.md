# agents-monitor

Claude Code 의 서브에이전트(`~/.claude/agents/*.md`)와 메인 대화가 지금 무엇을 하는지 실시간으로 보여 주는 로컬 대시보드입니다.

- 에이전트별 카드: 상태(대기 / 실행 / 완료 / 중단 / 응답 없음), 지금 쓰는 도구와 대상, 경과 시간, 도구 횟수, 최근 도구 흐름
- `main · 메인 대화` 카드: 질문하면 실행, 답변이 끝나면 응답 완료. 턴 단위로 집계
- 타임라인: 최근 실행 12건을 막대로 표시해 동시 실행이 보임
- 실시간 이벤트 목록, 세션 필터, 같은 에이전트 동시 실행 표시

외부 의존성 없이 Node.js 만 씁니다.

## 구조

```
hook.js     Claude Code 훅. 이벤트를 events/<세션>.jsonl 에 덧붙이기만 함
server.js   세션 파일을 읽어 SSE 로 브라우저에 보냄 (127.0.0.1 전용)
index.html  대시보드 화면
test/       테스트 (node 내장 test 러너)
docs/       설계 문서
plugin/agent-monitor/  터미널 사이드 패널 버전 (Claude Code 플러그인)
agents/     역할별 서브에이전트 7개 (architect, collector, debugger, docs-writer, implementer, reviewer, tester)
agent-rules/  에이전트 공통 규칙과 설계 문서 템플릿 (agent-rules/README.md 에 설명)
```

`events/` 에는 질문 내용, 실행한 명령, 파일 경로가 기록되므로 `.gitignore` 로 제외합니다.

## 설치

1. 이 저장소를 `~/.claude/agent-dashboard` 로 받습니다.

   ```
   git clone https://github.com/mayadep/agents-monitor.git ~/.claude/agent-dashboard
   ```

2. 에이전트와 공통 규칙을 `~/.claude/` 로 복사합니다. 대시보드는 `~/.claude/agents/` 에 있는 에이전트만 기록합니다.

   ```
   # bash (Git Bash, macOS, Linux)
   cp -r ~/.claude/agent-dashboard/agents ~/.claude/agent-dashboard/agent-rules ~/.claude/

   # PowerShell
   Copy-Item -Recurse -Force "$HOME\.claude\agent-dashboard\agents", "$HOME\.claude\agent-dashboard\agent-rules" "$HOME\.claude\"
   ```

   이미 같은 이름의 에이전트가 있으면 덮어씁니다. 저장소의 `agents/` 를 고친 뒤에도 다시 복사해야 반영됩니다.

3. `~/.claude/settings.json` 의 `hooks` 에 아래를 합칩니다. 기존 훅이 있으면 배열에 추가하세요.

   ```json
   {
     "hooks": {
       "SubagentStart":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "SubagentStop":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "Stop":               [{ "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "async": true, "timeout": 10 }] }],
       "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/agent-dashboard/hook.js\"", "timeout": 10 }] }]
     }
   }
   ```

   `SessionEnd` 만 동기 실행입니다. 세션이 닫히면서 기록이 끊기지 않게 하려는 것입니다.

4. 서버를 띄우고 http://localhost:7777 을 엽니다.

   ```
   node ~/.claude/agent-dashboard/server.js        # 다른 포트: node server.js 7800
   ```

   서버가 꺼져 있어도 훅은 계속 기록하므로, 나중에 켜면 그동안의 이벤트도 보입니다.

## 터미널 사이드 패널

브라우저 대신 Claude Code 화면 옆 패널로 보려면 플러그인을 불러옵니다.

```
claude --plugin-dir ~/.claude/agent-dashboard/plugin/agent-monitor
```

`/agents-pane` 으로 패널을 다시 열 수 있습니다.

## 기록 보존

- 세션마다 `events/<세션 ID>.jsonl` 파일 하나
- 서버가 10분마다 정리: 최근 30개, 7일 이내 파일만 남기고, 30분 안에 수정된 파일은 지우지 않음
- 세션 파일 하나가 20MB 를 넘으면 그 세션은 더 이상 기록하지 않음

## 보안

- `127.0.0.1` 에서만 열림
- Host 헤더가 `localhost` / `127.0.0.1` 이 아니면 거부 (DNS rebinding 방지)
- 기록 지우기는 대시보드 화면에서 보낸 요청(`X-Dashboard` 헤더, 같은 출처)만 받음

## 테스트

```
cd ~/.claude/agent-dashboard/test
node --test hook.test.js           # 훅: 임시 폴더의 사본으로 실행, 실제 events/ 는 건드리지 않음
node reducer.test.js ../index.html # 상태 계산
node render.test.js ../index.html  # 화면
```

남은 작업은 [TODO.md](TODO.md) 에 있습니다.
