# 역할별 Claude Code 서브에이전트 세트

## 구조
```
.claude/
  agents/            # 역할 에이전트 (Claude Code 가 자동 인식)
    collector.md     # 자료 단순 수집
    architect.md     # 설계
    implementer.md   # 구현
    reviewer.md      # 코드 리뷰
    tester.md        # 테스트
    debugger.md      # 디버깅
    docs-writer.md   # 문서
  agent-rules/       # 에이전트로 인식되지 않는 공유 영역
    common.md        # 모든 역할 공통 규칙 (파이프라인, 원칙, 컨텍스트 확인 순서, 보고 형식)
    design-doc-template.md  # docs/design.md 형식
    README.md        # 이 문서 (전역 설치 시 ~/.claude/agent-rules/README.md)
    _template.md     # 새 역할 추가용 템플릿
```

공통 규칙은 `common.md` 한 곳에만 두고 각 역할은 시작할 때 이 파일을 읽는다. 원칙을 바꿀 때 한 파일만 고치면 모든 역할에 반영된다.

## 설치
- 모든 프로젝트 공통 (전역): `agents/` 와 `agent-rules/` 를 `~/.claude/` 아래에 복사. Windows 는 `%USERPROFILE%\.claude\`
- 특정 레포에만: 이 `.claude` 폴더를 레포 루트에 복사

경로 수정은 필요 없다. 에이전트는 프로젝트 `.claude/agent-rules/` 가 있으면 그것을, 없으면 전역 `~/.claude/agent-rules/` 를 읽는다. 그래서 전역으로 깔아두고 특정 레포에서만 규칙을 바꾸고 싶으면 그 레포에 `.claude/agent-rules/` 만 두면 된다. 같은 이름의 에이전트를 레포 `.claude/agents/` 에 두면 그 레포에서는 레포 쪽이 우선한다.

복사 후 Claude Code 에서 `/agents` 로 목록이 보이는지 확인.

## 사용
- 자동: description 에 맞는 상황이면 메인 에이전트가 알아서 위임한다
- 직접: "architect 에이전트로 결제 모듈 설계해줘", "reviewer 로 지금 diff 리뷰해줘"
- 흐름 예시: collector → architect → implementer → tester → reviewer → docs-writer (버그 나오면 debugger)

## 작업 파이프라인
**설계(상위 모델) → `docs/design.md` → 구현(sonnet) → 검토(상위 모델, 별도 컨텍스트)**

대화 내용은 Claude Code 로 넘어가지 않으니 모든 설계 결정은 `docs/design.md` 한 문서에 담는다. 설계가 애매하면 sonnet 이 빈틈을 자기 판단으로 채워서 상위 모델로 설계한 의미가 사라진다. 그래서 문서에 모듈 구조, 인터페이스, 데이터 흐름, 하지 말아야 할 것까지 구체적으로 적고, implementer 는 문서에 없는 결정이 필요하면 멈추고 "설계 공백" 으로 되묻는다.

### 설계를 어디서 하나
| 상황 | 어디서 | 방법 |
|---|---|---|
| 새 프로젝트, 큰 방향 설계 | Claude 프로젝트 대화 (최고 모델) | 대화 결과를 `design-doc-template.md` 형식으로 정리해 레포의 `docs/design.md` 에 커밋 |
| 기존 코드를 고치거나 확장 | Claude Code 안, Opus | 플랜 모드(Shift+Tab 두 번)로 코드를 직접 읽으며 설계하거나 architect 에이전트에 맡김. 결과는 `docs/design.md` 로 |

프로젝트 대화는 실제 코드베이스를 못 보니, 기존 코드에 깊게 얽힌 설계는 반드시 Claude Code 쪽에서 한다.

### 단계별 진행
1. 설계: architect (또는 프로젝트 대화 / 플랜 모드) → `docs/design.md` 상태 "확정"
2. 구현: implementer 가 문서 7장 단계 순서대로. 설계 공백 나오면 1로 돌아가 문서 보강
3. 테스트: tester 가 문서의 완료 조건 기준으로
4. 검토: reviewer 가 diff 를 문서와 대조. 서브에이전트는 새 컨텍스트로 시작하지만, 더 확실하게 하려면 구현한 세션을 닫고 새 `claude` 세션에서 "reviewer 로 main 대비 diff 를 docs/design.md 와 대조해줘" 로 실행

### 레포 CLAUDE.md 에 넣을 한 줄
```
설계 문서는 docs/design.md 다. 구현 전에 반드시 읽고, 문서에 없는 결정은 임의로 정하지 말고 물어볼 것.
```

## 모델 배분 기준
토큰을 아끼려고 역할마다 모델을 고정했다. 메인 대화 모델과 상관없이 각 에이전트는 자기 frontmatter 의 `model` 로 돈다.

| 등급 | 모델 | 기준 | 역할 |
|---|---|---|---|
| 수집 | `haiku` | 판단 없이 찾고 옮기기만 함. 틀려도 다음 단계에서 걸러짐 | collector |
| 실행 | `sonnet` | 지시가 명확하고 결과를 테스트로 검증할 수 있음 | implementer, tester, debugger, docs-writer |
| 판단 | `claude-opus-5-5` + `effort: medium` | 결과가 이후 작업 전체 방향을 정하고, 실수가 비쌈. 최대 effort 대신 중간값으로 토큰 절약 | architect, reviewer |

새 역할의 모델을 정할 때:
1. 판단 없이 수집/변환만 하나? → `haiku`
2. 결과를 테스트나 다른 역할이 검증하나? → `sonnet`
3. 그 결과로 설계나 승인 같은 결정을 내리나? → `claude-opus-5-5`, `effort: medium`

등급을 한꺼번에 바꾸고 싶으면 해당 파일들의 `model:` (와 `effort:`) 줄만 고치면 된다. `effort` 는 low / medium / high / max 중 하나. 특정 에이전트가 메인 대화 모델을 따르게 하려면 `model: inherit`.

토큰 절약 팁: 큰 탐색은 collector 에게 먼저 맡겨서 자료를 모으고, 그 결과만 architect 나 메인 에이전트에 넘기면 비싼 모델이 파일을 직접 훑는 비용이 줄어든다.

## 역할 추가
1. `agent-rules/_template.md` 를 `agents/<이름>.md` 로 복사
2. frontmatter 의 name, description, tools, model 을 채운다
3. 책임 / 하지 않는 일 / 절차 / 산출물을 채운다. 공통 규칙은 다시 쓰지 않는다

## 설계 결정
- reviewer 는 Edit/Write 를 빼서 읽기 전용, architect 는 `docs/design.md` 만 쓰도록 제한했다
- 역할 간 전달은 대화가 아니라 `docs/design.md` 로만 한다
- "하지 않는 일" 섹션으로 역할 경계를 명시해 다음 역할로 넘기게 했다
