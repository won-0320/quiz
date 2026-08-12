-- 퀴즈 앱 스키마 — 빈 Supabase 프로젝트에 그대로 적용하면 된다.
--
-- 핵심 보안 제약: 정답이 학생에게 새지 않아야 한다.
--   - 네 테이블 모두 RLS를 켜고 익명(anon)에게는 어떤 정책도 주지 않는다.
--     따라서 학생이 테이블을 직접 조회하면 0행이 나온다.
--   - 학생은 아래 security definer 함수 세 개로만 접근한다. 그중
--     quiz_get_for_student 는 correct_choice / model_answer / rubric 을
--     반환 목록에서 아예 빼는 방식으로 정답을 숨긴다.
--   - 교사는 teacher_id = auth.uid() 인 행만 접근한다.

-- ============================================================
-- 테이블
-- ============================================================

create table if not exists public.quiz_quizzes (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  source_path   text,
  join_code     text unique,
  status        text not null default 'generating'
                  check (status in ('generating', 'draft', 'published')),
  mcq_count     integer not null default 0,
  short_count   integer not null default 0,
  difficulty    text not null default 'medium'
                  check (difficulty in ('easy', 'medium', 'hard')),
  allow_retake  boolean not null default false,
  error_message text,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);

create table if not exists public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  quiz_id        uuid not null references public.quiz_quizzes(id) on delete cascade,
  position       integer not null default 0,
  type           text not null check (type in ('mcq', 'short')),
  prompt         text not null,
  choices        jsonb,     -- 객관식만. 주관식은 null
  correct_choice integer,   -- 객관식만. 0-based 인덱스
  model_answer   text,      -- 주관식만
  rubric         text,      -- 주관식만
  points         numeric not null default 1 check (points > 0)
);

create table if not exists public.quiz_attempts (
  id             uuid primary key default gen_random_uuid(),
  quiz_id        uuid not null references public.quiz_quizzes(id) on delete cascade,
  student_name   text not null,
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  score          numeric not null default 0,   -- 트리거가 자동 재계산
  max_score      numeric not null default 0,
  grading_status text not null default 'pending'
                   check (grading_status in ('pending', 'done'))
);

create table if not exists public.quiz_answers (
  id             uuid primary key default gen_random_uuid(),
  attempt_id     uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id    uuid not null references public.quiz_questions(id) on delete cascade,
  response       text,
  is_correct     boolean,
  awarded_points numeric not null default 0,
  ai_reason      text,
  graded_by      text check (graded_by in ('auto', 'ai', 'teacher')),
  unique (attempt_id, question_id)
);

-- ============================================================
-- 인덱스
-- ============================================================

create index if not exists quiz_quizzes_teacher_idx
  on public.quiz_quizzes (teacher_id, created_at desc);
create index if not exists quiz_questions_quiz_idx
  on public.quiz_questions (quiz_id, "position");
create index if not exists quiz_attempts_quiz_idx
  on public.quiz_attempts (quiz_id, submitted_at desc);
create index if not exists quiz_answers_attempt_idx
  on public.quiz_answers (attempt_id);
create index if not exists quiz_answers_question_idx
  on public.quiz_answers (question_id);

-- ============================================================
-- RLS — 교사 본인만. 익명 정책은 의도적으로 만들지 않는다.
-- ============================================================

alter table public.quiz_quizzes  enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts  enable row level security;
alter table public.quiz_answers   enable row level security;

drop policy if exists quiz_quizzes_owner on public.quiz_quizzes;
create policy quiz_quizzes_owner on public.quiz_quizzes
  as permissive for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

drop policy if exists quiz_questions_owner on public.quiz_questions;
create policy quiz_questions_owner on public.quiz_questions
  as permissive for all to authenticated
  using (exists (select 1 from public.quiz_quizzes q
                  where q.id = quiz_questions.quiz_id and q.teacher_id = auth.uid()))
  with check (exists (select 1 from public.quiz_quizzes q
                       where q.id = quiz_questions.quiz_id and q.teacher_id = auth.uid()));

drop policy if exists quiz_attempts_owner on public.quiz_attempts;
create policy quiz_attempts_owner on public.quiz_attempts
  as permissive for all to authenticated
  using (exists (select 1 from public.quiz_quizzes q
                  where q.id = quiz_attempts.quiz_id and q.teacher_id = auth.uid()))
  with check (exists (select 1 from public.quiz_quizzes q
                       where q.id = quiz_attempts.quiz_id and q.teacher_id = auth.uid()));

drop policy if exists quiz_answers_owner on public.quiz_answers;
create policy quiz_answers_owner on public.quiz_answers
  as permissive for all to authenticated
  using (exists (select 1 from public.quiz_attempts a
                   join public.quiz_quizzes q on q.id = a.quiz_id
                  where a.id = quiz_answers.attempt_id and q.teacher_id = auth.uid()))
  with check (exists (select 1 from public.quiz_attempts a
                        join public.quiz_quizzes q on q.id = a.quiz_id
                       where a.id = quiz_answers.attempt_id and q.teacher_id = auth.uid()));

-- ============================================================
-- 함수
-- ============================================================

-- 참여 코드 생성. 헷갈리는 글자(0/O, 1/I)를 뺀 32자 알파벳에서 6자리.
create or replace function public.quiz_generate_join_code()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.quiz_quizzes where join_code = code);
  end loop;
  return code;
end;
$function$;

-- 퀴즈 배포. 교사 본인만, 문항이 하나 이상 있을 때만.
create or replace function public.quiz_publish(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner uuid;
  v_code  text;
  v_count int;
begin
  select teacher_id, join_code into v_owner, v_code
    from public.quiz_quizzes where id = p_quiz_id;

  if v_owner is null then raise exception 'QUIZ_NOT_FOUND'; end if;
  if v_owner <> auth.uid() then raise exception 'FORBIDDEN'; end if;

  select count(*) into v_count from public.quiz_questions where quiz_id = p_quiz_id;
  if v_count = 0 then raise exception 'NO_QUESTIONS'; end if;

  if v_code is null then
    v_code := public.quiz_generate_join_code();
  end if;

  update public.quiz_quizzes
     set join_code = v_code, status = 'published', published_at = now()
   where id = p_quiz_id;

  return jsonb_build_object('join_code', v_code);
end;
$function$;

-- 학생용 문제 조회. correct_choice / model_answer / rubric 을 반환하지 않는 것이 핵심이다.
create or replace function public.quiz_get_for_student(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quiz public.quiz_quizzes;
  v_questions jsonb;
begin
  select * into v_quiz
    from public.quiz_quizzes
   where join_code = upper(btrim(p_code)) and status = 'published';

  if v_quiz.id is null then raise exception 'QUIZ_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', q.id,
             'position', q.position,
             'type', q.type,
             'prompt', q.prompt,
             'choices', q.choices,
             'points', q.points
           ) order by q.position, q.id
         ), '[]'::jsonb)
    into v_questions
    from public.quiz_questions q
   where q.quiz_id = v_quiz.id;

  return jsonb_build_object(
    'quiz_id', v_quiz.id,
    'title', v_quiz.title,
    'allow_retake', v_quiz.allow_retake,
    'questions', v_questions
  );
end;
$function$;

-- 답안 제출. 객관식 채점을 서버에서 수행한다 (클라이언트가 정답을 알 필요가 없다).
create or replace function public.quiz_submit_attempt(p_code text, p_name text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quiz       public.quiz_quizzes;
  v_attempt_id uuid;
  v_name       text := btrim(coalesce(p_name, ''));
  r            record;
  v_resp       text;
  v_correct    boolean;
  v_max        numeric := 0;
  v_pending    boolean := false;
begin
  if v_name = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_name) > 40 then raise exception 'NAME_TOO_LONG'; end if;

  select * into v_quiz
    from public.quiz_quizzes
   where join_code = upper(btrim(p_code)) and status = 'published';

  if v_quiz.id is null then raise exception 'QUIZ_NOT_FOUND'; end if;

  if not v_quiz.allow_retake and exists (
       select 1 from public.quiz_attempts a
        where a.quiz_id = v_quiz.id
          and lower(a.student_name) = lower(v_name)
          and a.submitted_at is not null)
  then
    raise exception 'ALREADY_SUBMITTED';
  end if;

  select coalesce(sum(points), 0) into v_max
    from public.quiz_questions where quiz_id = v_quiz.id;

  insert into public.quiz_attempts (quiz_id, student_name, submitted_at, max_score, grading_status)
  values (v_quiz.id, v_name, now(), v_max, 'pending')
  returning id into v_attempt_id;

  for r in select * from public.quiz_questions where quiz_id = v_quiz.id order by position, id loop
    v_resp := left(coalesce(p_answers ->> r.id::text, ''), 4000);

    if r.type = 'mcq' then
      v_correct := (v_resp ~ '^\d+$' and v_resp::int = r.correct_choice);
      insert into public.quiz_answers (attempt_id, question_id, response, is_correct, awarded_points, graded_by)
      values (v_attempt_id, r.id, nullif(v_resp, ''), v_correct,
              case when v_correct then r.points else 0 end, 'auto');
    else
      v_pending := true;
      insert into public.quiz_answers (attempt_id, question_id, response, is_correct, awarded_points, graded_by)
      values (v_attempt_id, r.id, nullif(v_resp, ''), null, 0, null);
    end if;
  end loop;

  if not v_pending then
    update public.quiz_attempts set grading_status = 'done' where id = v_attempt_id;
  end if;

  return (
    select jsonb_build_object(
             'attempt_id', a.id,
             'score', a.score,
             'max_score', a.max_score,
             'grading_status', a.grading_status)
      from public.quiz_attempts a where a.id = v_attempt_id
  );
end;
$function$;

-- 학생이 제출 후 채점 완료를 폴링할 때 쓴다.
create or replace function public.quiz_get_attempt_result(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  select jsonb_build_object(
           'attempt_id', a.id,
           'score', a.score,
           'max_score', a.max_score,
           'grading_status', a.grading_status)
    into v_result
    from public.quiz_attempts a where a.id = p_attempt_id;

  if v_result is null then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  return v_result;
end;
$function$;

-- 답안이 바뀔 때마다 응시 총점을 다시 계산한다 (AI 채점·교사 수정 모두 포함).
create or replace function public.quiz_recalc_attempt_score()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_attempt uuid;
begin
  v_attempt := coalesce(new.attempt_id, old.attempt_id);
  update public.quiz_attempts a
     set score = coalesce((select sum(x.awarded_points)
                             from public.quiz_answers x
                            where x.attempt_id = v_attempt), 0)
   where a.id = v_attempt;
  return null;
end;
$function$;

drop trigger if exists quiz_answers_recalc on public.quiz_answers;
create trigger quiz_answers_recalc
  after insert or delete or update on public.quiz_answers
  for each row execute function public.quiz_recalc_attempt_score();

-- ============================================================
-- 함수 실행 권한
-- ============================================================

-- 학생(익명)이 호출하는 세 개만 anon 에게 연다.
grant execute on function public.quiz_get_for_student(text)            to anon, authenticated;
grant execute on function public.quiz_submit_attempt(text, text, jsonb) to anon, authenticated;
grant execute on function public.quiz_get_attempt_result(uuid)          to anon, authenticated;

-- 배포는 교사만.
revoke all on function public.quiz_publish(uuid) from public, anon;
grant execute on function public.quiz_publish(uuid) to authenticated;

-- 코드 생성기는 quiz_publish 내부에서만 쓰인다. 외부 노출 금지.
revoke all on function public.quiz_generate_join_code() from public, anon, authenticated;

-- 트리거 전용 함수도 마찬가지로 REST 에 노출될 이유가 없다.
revoke all on function public.quiz_recalc_attempt_score() from public, anon, authenticated;

-- ============================================================
-- 스토리지 — 비공개 버킷. 경로는 {교사 uid}/{퀴즈 id}.pdf
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-pdfs', 'quiz-pdfs', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists quiz_pdfs_teacher_all on storage.objects;
create policy quiz_pdfs_teacher_all on storage.objects
  as permissive for all to authenticated
  using (bucket_id = 'quiz-pdfs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'quiz-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
