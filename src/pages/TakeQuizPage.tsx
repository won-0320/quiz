import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Button, Card, ErrorBox, Input, Loading, Spinner, Textarea } from '../components/ui'
import type { AttemptResult, StudentQuiz } from '../lib/types'

type Stage = 'name' | 'quiz' | 'done'

function friendlyError(message: string): string {
  if (message.includes('QUIZ_NOT_FOUND'))
    return '해당 코드의 퀴즈를 찾을 수 없습니다. 코드를 다시 확인해 주세요.'
  if (message.includes('ALREADY_SUBMITTED'))
    return '이미 제출한 이름입니다. 선생님께 문의하세요.'
  if (message.includes('NAME_REQUIRED')) return '이름을 입력해 주세요.'
  if (message.includes('NAME_TOO_LONG')) return '이름이 너무 깁니다.'
  return message
}

export default function TakeQuizPage() {
  const { code = '' } = useParams<{ code: string }>()
  const [quiz, setQuiz] = useState<StudentQuiz | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [stage, setStage] = useState<Stage>('name')
  const [name, setName] = useState('')
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<AttemptResult | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    supabase
      .rpc('quiz_get_for_student', { p_code: code })
      .then(({ data, error }) => {
        if (error) setError(friendlyError(error.message))
        else setQuiz(data as StudentQuiz)
        setLoading(false)
      })
  }, [code])

  // 주관식 AI 채점이 끝날 때까지 결과를 폴링
  const pollResult = useCallback((attemptId: string) => {
    let tries = 0
    pollRef.current = window.setInterval(async () => {
      tries += 1
      const { data } = await supabase.rpc('quiz_get_attempt_result', { p_attempt_id: attemptId })
      const r = data as AttemptResult | null
      if (r) setResult(r)
      if ((r && r.grading_status === 'done') || tries > 30) {
        if (pollRef.current) window.clearInterval(pollRef.current)
      }
    }, 2000)
  }, [])

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
  }, [])

  function startQuiz(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setStage('quiz')
  }

  async function submit() {
    if (!quiz) return
    setSubmitting(true)
    setError('')
    const { data, error: rpcErr } = await supabase.rpc('quiz_submit_attempt', {
      p_code: code,
      p_name: name.trim(),
      p_answers: answers,
    })
    if (rpcErr) {
      setSubmitting(false)
      setError(friendlyError(rpcErr.message))
      return
    }
    const r = data as AttemptResult
    setResult(r)
    setStage('done')
    setSubmitting(false)

    if (r.grading_status === 'pending') {
      // 주관식 채점 요청 (실패해도 객관식 점수는 이미 확정되어 있다)
      void supabase.functions.invoke('grade-short-answers', { body: { attempt_id: r.attempt_id } })
      pollResult(r.attempt_id)
    }
  }

  if (loading) return <Loading />

  if (!quiz) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          <ErrorBox>{error || '퀴즈를 불러오지 못했습니다.'}</ErrorBox>
          <Link to="/j">
            <Button variant="secondary" full>
              코드 다시 입력
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  // 1) 이름 입력
  if (stage === 'name') {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-bold break-words">{quiz.title}</h1>
            <p className="mt-1 text-sm text-slate-500">{quiz.questions.length}문항</p>
          </div>
          <Card>
            <form onSubmit={startQuiz} className="space-y-3">
              <Input
                label="이름"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 2학년 3반 김민준"
                maxLength={40}
                required
                autoFocus
              />
              <p className="text-xs text-slate-500">
                같은 반에 이름이 겹치면 반까지 함께 적어 주세요.
              </p>
              <Button type="submit" full disabled={!name.trim()}>
                시작하기
              </Button>
            </form>
          </Card>
        </div>
      </div>
    )
  }

  // 3) 결과
  if (stage === 'done' && result) {
    const percent = result.max_score > 0 ? Math.round((result.score / result.max_score) * 100) : 0
    const pending = result.grading_status === 'pending'
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm text-center">
          <div className="text-4xl">{pending ? '⏳' : percent >= 80 ? '🎉' : '📘'}</div>
          <h1 className="mt-3 text-xl font-bold">제출 완료!</h1>
          <p className="mt-1 text-sm text-slate-500">{name}</p>

          <Card className="mt-5">
            <p className="text-sm text-slate-500">점수</p>
            <p className="mt-1 text-5xl font-black text-indigo-600 tabular-nums">
              {Number(result.score)}
              <span className="text-2xl text-slate-400"> / {Number(result.max_score)}</span>
            </p>
            <p className="mt-1 text-sm text-slate-500">100점 만점 환산 {percent}점</p>

            {pending && (
              <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
                <Spinner className="h-4 w-4" />
                주관식을 채점하고 있습니다…
              </div>
            )}
          </Card>

          <p className="mt-5 text-sm text-slate-500">이 화면은 닫으셔도 됩니다.</p>
        </div>
      </div>
    )
  }

  // 2) 문항 풀이
  const q = quiz.questions[index]
  const answered = Object.values(answers).filter((v) => v?.trim()).length
  const isLast = index === quiz.questions.length - 1

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pt-4 pb-6">
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
          <span>
            {index + 1} / {quiz.questions.length}
          </span>
          <span>{answered}문항 응답함</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${((index + 1) / quiz.questions.length) * 100}%` }}
          />
        </div>
      </div>

      <Card className="flex-1">
        <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium">
            {q.type === 'mcq' ? '객관식' : '주관식'}
          </span>
          <span>{Number(q.points)}점</span>
        </div>

        <p className="text-base leading-relaxed font-medium whitespace-pre-wrap">{q.prompt}</p>

        {q.type === 'mcq' ? (
          <div className="mt-4 space-y-2">
            {(q.choices ?? []).map((choice, ci) => {
              const selected = answers[q.id] === String(ci)
              return (
                <button
                  key={ci}
                  type="button"
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: String(ci) }))}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                    selected
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-900'
                      : 'border-slate-300 bg-white hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                      selected
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : 'border-slate-300 text-slate-500'
                    }`}
                  >
                    {ci + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{choice}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="mt-4">
            <Textarea
              rows={4}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              placeholder="답을 적어 주세요"
              maxLength={2000}
            />
          </div>
        )}
      </Card>

      {error && (
        <div className="mt-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={index === 0}
          onClick={() => setIndex((i) => i - 1)}
        >
          이전
        </Button>
        {isLast ? (
          <Button
            className="flex-1"
            loading={submitting}
            onClick={() => {
              const unanswered = quiz.questions.filter((qq) => !answers[qq.id]?.trim()).length
              if (
                unanswered > 0 &&
                !window.confirm(`아직 ${unanswered}문항을 풀지 않았습니다. 제출할까요?`)
              )
                return
              void submit()
            }}
          >
            제출하기
          </Button>
        ) : (
          <Button className="flex-1" onClick={() => setIndex((i) => i + 1)}>
            다음
          </Button>
        )}
      </div>
    </div>
  )
}
