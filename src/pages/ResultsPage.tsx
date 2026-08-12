import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Page } from '../components/ui'
import type { Answer, Attempt, Question, Quiz } from '../lib/types'

type Tab = 'students' | 'questions' | 'detail'

export default function ResultsPage() {
  const { id: quizId } = useParams<{ id: string }>()
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('students')
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!quizId) return
    const [{ data: q }, { data: qs }, { data: ats, error: atErr }] = await Promise.all([
      supabase.from('quiz_quizzes').select('*').eq('id', quizId).single(),
      supabase.from('quiz_questions').select('*').eq('quiz_id', quizId).order('position'),
      supabase
        .from('quiz_attempts')
        .select('*')
        .eq('quiz_id', quizId)
        .not('submitted_at', 'is', null)
        .order('submitted_at', { ascending: false }),
    ])
    if (atErr) setError(atErr.message)
    setQuiz((q ?? null) as Quiz | null)
    setQuestions((qs ?? []) as Question[])
    const attemptList = (ats ?? []) as Attempt[]
    setAttempts(attemptList)

    if (attemptList.length > 0) {
      const { data: ans } = await supabase
        .from('quiz_answers')
        .select('*')
        .in(
          'attempt_id',
          attemptList.map((a) => a.id),
        )
      setAnswers((ans ?? []) as Answer[])
    } else {
      setAnswers([])
    }
    setLoading(false)
  }, [quizId])

  useEffect(() => {
    void load()
  }, [load])

  const answersByAttempt = useMemo(() => {
    const map = new Map<string, Map<string, Answer>>()
    for (const a of answers) {
      let inner = map.get(a.attempt_id)
      if (!inner) map.set(a.attempt_id, (inner = new Map()))
      inner.set(a.question_id, a)
    }
    return map
  }, [answers])

  /** 문항별 정답률 — 배점 대비 획득 점수의 평균 */
  const questionStats = useMemo(() => {
    return questions.map((q) => {
      const rows = answers.filter((a) => a.question_id === q.id)
      const earned = rows.reduce((s, a) => s + Number(a.awarded_points), 0)
      const possible = rows.length * Number(q.points)
      return {
        question: q,
        responses: rows.length,
        rate: possible > 0 ? Math.round((earned / possible) * 100) : null,
      }
    })
  }, [questions, answers])

  const average = useMemo(() => {
    const graded = attempts.filter((a) => a.max_score > 0)
    if (graded.length === 0) return null
    return Math.round(
      graded.reduce((s, a) => s + (Number(a.score) / Number(a.max_score)) * 100, 0) / graded.length,
    )
  }, [attempts])

  async function setScore(answer: Answer, points: number) {
    const q = questions.find((x) => x.id === answer.question_id)
    if (!q) return
    const clamped = Math.max(0, Math.min(Number(q.points), points))
    const { error } = await supabase
      .from('quiz_answers')
      .update({
        awarded_points: clamped,
        is_correct: clamped >= Number(q.points),
        graded_by: 'teacher',
      })
      .eq('id', answer.id)
    if (error) {
      setError(error.message)
      return
    }
    await load()
  }

  function downloadCsv() {
    if (!quiz) return
    const header = [
      '이름',
      '총점',
      '만점',
      '백분율',
      '제출시각',
      ...questions.map((q, i) => `${i + 1}번(${Number(q.points)}점)`),
    ]
    const rows = attempts.map((at) => {
      const map = answersByAttempt.get(at.id)
      return [
        at.student_name,
        String(Number(at.score)),
        String(Number(at.max_score)),
        at.max_score > 0 ? String(Math.round((Number(at.score) / Number(at.max_score)) * 100)) : '',
        at.submitted_at ? new Date(at.submitted_at).toLocaleString('ko-KR') : '',
        ...questions.map((q) => String(Number(map?.get(q.id)?.awarded_points ?? 0))),
      ]
    })

    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
    const csv = [header, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')
    // Excel이 한글을 깨뜨리지 않도록 UTF-8 BOM 을 붙인다
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${quiz.title.replace(/[\\/:*?"<>|]/g, '_')}_결과.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <Loading />
  if (!quiz) return <Page title="오류"><ErrorBox>{error || '퀴즈를 찾을 수 없습니다.'}</ErrorBox></Page>

  const selectedAttempt = attempts.find((a) => a.id === selected) ?? null

  return (
    <Page
      title="결과"
      subtitle={quiz.title}
      back={
        <Link to="/" className="text-slate-400 hover:text-slate-600" aria-label="뒤로">
          ←
        </Link>
      }
      right={
        quiz.join_code ? (
          <Link to={`/quiz/${quiz.id}/share`}>
            <Badge tone="indigo">{quiz.join_code}</Badge>
          </Link>
        ) : undefined
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Card className="py-3 text-center">
          <p className="text-xs text-slate-500">응시</p>
          <p className="text-2xl font-bold tabular-nums">{attempts.length}명</p>
        </Card>
        <Card className="py-3 text-center">
          <p className="text-xs text-slate-500">평균</p>
          <p className="text-2xl font-bold tabular-nums">{average === null ? '–' : `${average}%`}</p>
        </Card>
      </div>

      <div className="mb-4 flex gap-1 rounded-xl bg-slate-200 p-1">
        {(
          [
            ['students', '학생별'],
            ['questions', '문항별'],
            ['detail', '답안 상세'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`min-h-9 flex-1 rounded-lg px-2 text-sm font-medium transition-colors ${
              tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {attempts.length === 0 ? (
        <Empty title="아직 응시한 학생이 없습니다">
          {quiz.join_code ? (
            <>
              참여 코드 <span className="font-mono font-bold">{quiz.join_code}</span> 를 학생들에게
              알려주세요.
            </>
          ) : (
            '먼저 퀴즈를 배포하세요.'
          )}
        </Empty>
      ) : tab === 'students' ? (
        <>
          <ul className="space-y-2">
            {[...attempts]
              .sort((a, b) => Number(b.score) - Number(a.score))
              .map((at) => {
                const pct =
                  at.max_score > 0 ? Math.round((Number(at.score) / Number(at.max_score)) * 100) : 0
                return (
                  <li key={at.id}>
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => {
                        setSelected(at.id)
                        setTab('detail')
                      }}
                    >
                      <Card className="flex items-center gap-3 py-3 transition-shadow hover:shadow-md">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{at.student_name}</p>
                          <p className="text-xs text-slate-500">
                            {at.submitted_at &&
                              new Date(at.submitted_at).toLocaleString('ko-KR', {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            {at.grading_status === 'pending' && ' · 채점 중'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg font-bold tabular-nums">
                            {Number(at.score)}
                            <span className="text-sm font-normal text-slate-400">
                              /{Number(at.max_score)}
                            </span>
                          </p>
                          <p className="text-xs text-slate-500 tabular-nums">{pct}%</p>
                        </div>
                      </Card>
                    </button>
                  </li>
                )
              })}
          </ul>
          <Button variant="secondary" full className="mt-4" onClick={downloadCsv}>
            CSV 내보내기
          </Button>
        </>
      ) : tab === 'questions' ? (
        <ul className="space-y-2">
          {[...questionStats]
            .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101))
            .map((s) => {
              const originalIndex = questions.findIndex((q) => q.id === s.question.id)
              return (
                <li key={s.question.id}>
                  <Card className="py-3">
                    <div className="flex items-start gap-2">
                      <span className="text-sm font-bold text-slate-400">{originalIndex + 1}</span>
                      <p className="min-w-0 flex-1 text-sm break-words">{s.question.prompt}</p>
                      <span
                        className={`shrink-0 text-sm font-bold tabular-nums ${
                          s.rate === null
                            ? 'text-slate-400'
                            : s.rate < 50
                              ? 'text-red-600'
                              : s.rate < 80
                                ? 'text-amber-600'
                                : 'text-emerald-600'
                        }`}
                      >
                        {s.rate === null ? '–' : `${s.rate}%`}
                      </span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full ${
                          (s.rate ?? 0) < 50
                            ? 'bg-red-500'
                            : (s.rate ?? 0) < 80
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                        }`}
                        style={{ width: `${s.rate ?? 0}%` }}
                      />
                    </div>
                  </Card>
                </li>
              )
            })}
        </ul>
      ) : (
        <div>
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value || null)}
            className="mb-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-indigo-500"
          >
            <option value="">학생을 선택하세요</option>
            {attempts.map((at) => (
              <option key={at.id} value={at.id}>
                {at.student_name} — {Number(at.score)}/{Number(at.max_score)}
              </option>
            ))}
          </select>

          {!selectedAttempt ? (
            <Empty title="학생을 선택하면 문항별 답안이 보입니다" />
          ) : (
            <ul className="space-y-2">
              {questions.map((q, i) => {
                const a = answersByAttempt.get(selectedAttempt.id)?.get(q.id)
                const awarded = Number(a?.awarded_points ?? 0)
                const full = awarded >= Number(q.points)
                return (
                  <li key={q.id}>
                    <Card className="space-y-2 py-3">
                      <div className="flex items-start gap-2">
                        <span className="text-sm font-bold text-slate-400">{i + 1}</span>
                        <p className="min-w-0 flex-1 text-sm break-words">{q.prompt}</p>
                        <Badge tone={full ? 'green' : awarded > 0 ? 'amber' : 'red'}>
                          {awarded}/{Number(q.points)}
                        </Badge>
                      </div>

                      <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <span className="text-xs text-slate-500">학생 답</span>
                        <p className="break-words whitespace-pre-wrap">
                          {q.type === 'mcq'
                            ? a?.response != null && q.choices?.[Number(a.response)] != null
                              ? `${Number(a.response) + 1}. ${q.choices[Number(a.response)]}`
                              : '무응답'
                            : a?.response || '무응답'}
                        </p>
                      </div>

                      {q.type === 'mcq' ? (
                        <p className="text-xs text-slate-500">
                          정답: {(q.correct_choice ?? 0) + 1}.{' '}
                          {q.choices?.[q.correct_choice ?? 0] ?? ''}
                        </p>
                      ) : (
                        <>
                          <p className="text-xs text-slate-500">모범답안: {q.model_answer}</p>
                          {a?.ai_reason && (
                            <p
                              className={`text-xs ${
                                a.graded_by === 'ai' ? 'text-slate-500' : 'text-amber-700'
                              }`}
                            >
                              {a.graded_by === 'ai' ? 'AI 채점: ' : '채점 메모: '}
                              {a.ai_reason}
                            </p>
                          )}
                          {a && (
                            <div className="flex items-center gap-2 pt-1">
                              <span className="text-xs font-medium text-slate-500">점수 수정</span>
                              <input
                                type="number"
                                min={0}
                                max={Number(q.points)}
                                step="0.5"
                                defaultValue={awarded}
                                key={`${a.id}-${awarded}`}
                                onBlur={(e) => {
                                  const v = Number(e.target.value)
                                  if (!Number.isNaN(v) && v !== awarded) void setScore(a, v)
                                }}
                                className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
                              />
                              <span className="text-xs text-slate-400">
                                / {Number(q.points)}점
                                {a.graded_by === 'teacher' && ' · 교사 수정됨'}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </Card>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Page>
  )
}
