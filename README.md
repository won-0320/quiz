# 퀴즈 만들기 — 출제·응시·채점 웹앱

교사가 퀴즈를 만들면 학생은 휴대폰으로 참여 코드만 입력해 풀고,
교사는 점수와 문항별 정답률을 바로 확인하는 모바일 웹앱입니다.

## 흐름

출제는 두 가지 방식 중에 고릅니다.

```
교사(직접 출제):  제목 입력 → 문항 직접 작성 → 배포(6자리 코드 + QR)
교사(AI 생성):    PDF 업로드 → AI 문항 생성 → 검토·수정 → 배포     ※ API 결제 필요

학생: 코드 입력 → 이름 입력 → 풀이 → 제출 → 점수 확인
교사: 학생별 점수 / 문항별 정답률 / 답안 상세 / CSV 내보내기
```

**AI 없이도 앱 전체가 동작합니다.** 결제가 필요한 것은 아래 두 가지뿐입니다.

| 기능 | AI 없이 | AI 연결 시 |
|---|---|---|
| 문항 출제 | 교사가 직접 작성 | PDF를 읽고 자동 생성 |
| 객관식 채점 | **자동** (DB 함수가 서버에서 처리) | 동일 |
| 주관식 채점 | 0점으로 두고 교사가 채점 | 모범답안과 대조해 자동 채점 |
| 배포·응시·결과·CSV | 전부 동작 | 동일 |

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
```

`.env.local` 에 Supabase 접속 정보가 들어 있습니다 (`.env.example` 참고).

## 구성

| 부분 | 위치 | 설명 |
|---|---|---|
| 프론트엔드 | `src/` | Vite + React + TypeScript + Tailwind. 모바일 우선 |
| 교사 화면 | `src/pages/{Login,QuizList,NewQuiz,Review,Share,Results}Page.tsx` | 로그인 필요 |
| 학생 화면 | `src/pages/{Join,TakeQuiz}Page.tsx` | 로그인 불필요 |
| 문항 생성 | `supabase/functions/generate-quiz/` | PDF → Claude API → 문항 |
| 주관식 채점 | `supabase/functions/grade-short-answers/` | 답안 → Claude API → 점수·사유 |
| DB 스키마 | `supabase/migrations/0001_quiz_schema.sql` | 테이블·RLS·RPC·스토리지 버킷 전체 |

DB는 Supabase 프로젝트(`won1234's Project`, ref `esmawsytnyimshmgjxjf`) 안에
`quiz_` 접두사 테이블 4개(`quiz_quizzes`, `quiz_questions`, `quiz_attempts`, `quiz_answers`)로
들어 있습니다. 접두사를 쓰므로 같은 프로젝트의 다른 테이블과 섞이지 않습니다.

## 보안 설계

정답이 학생에게 새지 않는 것이 이 앱의 핵심 제약입니다.

- 네 테이블 모두 RLS가 켜져 있고, **익명 사용자에게는 어떤 정책도 부여하지 않습니다.**
  브라우저 콘솔에서 `quiz_questions` 를 직접 조회하면 0행이 나옵니다.
- 학생은 `security definer` RPC 두 개로만 접근합니다:
  - `quiz_get_for_student(code)` — `correct_choice` / `model_answer` / `rubric` 을 **제외한** 필드만 반환
  - `quiz_submit_attempt(code, name, answers)` — 객관식 채점을 **서버에서** 수행
- 교사는 `teacher_id = auth.uid()` 인 행만 접근합니다.
- `ANTHROPIC_API_KEY` 는 Edge Function 시크릿에만 두고 브라우저로 내려보내지 않습니다.
- 업로드한 PDF는 비공개 버킷의 `{교사 uid}/{퀴즈 id}.pdf` 경로에만 저장됩니다.

## AI 연결 (선택 — 아직 미설정)

지금은 API 키가 없어 두 함수 모두 **mock 모드**로 동작합니다.
문항 생성은 샘플 자리표시자를 만들고, 주관식 채점은 0점에 "선생님이 채점할 예정입니다" 메모만
남깁니다. 임의로 부분점수를 주면 학생이 그것을 최종 점수로 오해하기 때문입니다.
학생 결과 화면도 이때는 **객관식 점수**만 보여주고 환산 점수를 감춥니다.

> **API 요금은 별도입니다.** ChatGPT Plus 나 Claude Pro 구독에는 **API 크레딧이 포함되지
> 않습니다.** 콘솔에서 결제수단을 등록하고 크레딧을 충전해야 합니다. 예상치 못한 지출을
> 막으려면 콘솔에서 사용량 한도(budget limit)를 함께 걸어 두세요.

키가 생기면 아래 한 줄이면 실제 AI로 전환됩니다. 코드 수정은 필요 없습니다.

```bash
# Supabase 대시보드 → Edge Functions → Secrets 에서 추가하거나
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

`MOCK_AI=true` 시크릿을 넣으면 키가 있어도 mock 모드로 되돌릴 수 있습니다.

사용 모델은 `claude-opus-5` 이며, 문항 생성은 `effort: medium`, 채점은 `effort: low` 입니다.
문항 구조와 채점 결과는 프롬프트가 아니라 **JSON Schema(구조화 출력)** 로 강제합니다.

## 빈 Supabase 프로젝트에 새로 설치하기

1. SQL Editor 에서 `supabase/migrations/0001_quiz_schema.sql` 실행
   (테이블 4개, RLS 정책, RPC 6개, 트리거, `quiz-pdfs` 버킷이 한 번에 만들어집니다)
2. Edge Function 두 개 배포 — `supabase functions deploy generate-quiz grade-short-answers`
3. 시크릿 설정 — `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
4. `.env.local` 에 새 프로젝트의 URL 과 **legacy anon 키(JWT)** 기입 (`.env.example` 의 주의사항 참고)
5. 아래 "교사 계정" 절차대로 계정 생성

## 배포

`vercel.json` 의 리라이트 규칙이 있어야 학생이 QR 로 여는 `/j/{코드}` 주소가
정적 호스팅에서 404 가 나지 않습니다. Vercel 프로젝트 환경변수에
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 를 반드시 등록하세요 —
Vite 는 빌드 시점에 값을 굽기 때문에 빠뜨리면 흰 화면이 됩니다.

## 교사 계정

계정은 대시보드에서 만듭니다:

Authentication → Users → **Add user** → Create new user → **Auto Confirm User** 체크

로그인 화면에 "교사 가입" 토글이 있지만, **공개 회원가입은 반드시 대시보드에서 꺼야 합니다.**
(꺼 두면 그 토글은 "관리자에게 계정 생성을 요청하세요" 안내로 자연스럽게 막힙니다.)
켜져 있으면 누구나 `/auth/v1/signup` 을 직접 호출해 교사 계정을 만들고 문항 생성
(= Anthropic API 비용)을 쓸 수 있습니다. RLS 가 `teacher_id` 로 막아 주므로 남의 퀴즈나
답안이 보이지는 않지만, 자원 남용은 막지 못합니다.

Authentication → Sign In / Providers → Email → **Allow new users to sign up** 끄기

## 알려진 제약

- PDF는 20MB 이하. Edge Function 실행 시간(약 150초) 때문에 문항은 한 번에 최대 30개.
  더 큰 자료·많은 문항이 필요해지면 `quiz_quizzes.status = 'generating'` 을 이용해
  백그라운드 작업 + 폴링으로 전환할 수 있습니다(스키마 변경 불필요).
- 동명이인은 구분되지 않습니다. 학생에게 "이름(반)" 형태로 입력하도록 안내합니다.
