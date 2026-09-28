# Agent Usage Monitor

- 이 저장소는 개인 PC에서만 실행되는 로컬 도구다. 외부 주소에 바인딩하거나 사용량 데이터를 업로드하지 않는다.
- 유일한 외부 요청은 Claude 플랜 사용량 조회(`api.anthropic.com`)이며, CLI 토큰은 읽기만 하고 갱신·기록·복사하지 않는다.
- 원본 Codex/Claude JSONL은 항상 읽기 전용으로 취급한다.
- `codex-auto-review`는 사용자 합계에서 제외한다.
- 세션 귀속은 시간 추정보다 `session_id`, `parent_thread_id`, `turn_id`를 우선한다. Claude는 같은 `message.id`가 스트리밍 중 여러 줄로 기록되므로 최대 사용량 한 건만 센다.
- 제공자별 파서는 `src/parsers/`에 두고 `{ provider, createState, parse }` 인터페이스를 따른다.
- 작업 표시줄 표시기(`taskbar/`)는 `/api/taskbar`만 읽는다. 응답 필드를 바꾸면 `UsageSnapshot.cs`도 함께 확인한다.
- 변경 후 `npm test`와 실제 `/api/health`, `/api/turns`, `/api/taskbar` 응답을 검증한다.
