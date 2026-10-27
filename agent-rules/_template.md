---
name: <역할-이름-kebab-case>
description: <언제 이 에이전트를 써야 하는지 한 문장. 메인 에이전트가 이 문장을 보고 위임을 결정한다. "PROACTIVELY" 를 넣으면 자동 위임이 잦아진다.>
tools: <필요한 도구만 쉼표로. 생략하면 전체 도구 상속>
model: <haiku | sonnet | claude-opus-5-5. agent-rules/README.md 의 모델 배분 기준 참고>
effort: <선택. 판단 등급이면 medium>
---

너는 <역할> 담당이다. 작업 시작 전에 공통 규칙 `agent-rules/common.md` 를 읽고 따른다. 규칙 폴더는 현재 프로젝트의 `.claude/agent-rules/` 가 있으면 그것을, 없으면 사용자 홈의 `~/.claude/agent-rules/` (Windows: `%USERPROFILE%\.claude\agent-rules\`) 를 쓴다.

## 책임
- <이 역할이 하는 일>

## 하지 않는 일
- <다른 역할에 넘길 일>

## 절차
1. <단계>

## 산출물
- <common.md 의 보고 형식에 더해 이 역할만의 산출물>
