import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { readFunctionError } from '../lib/fnError'
import { Badge, Button, Card, ErrorBox, Input, Loading, Page, Spinner, Textarea } from '../components/ui'
import type { Question, Quiz, QuestionType } from '../lib/types'

/** 아직 저장되지 않은 새 문항은 id가 "new-"로 시작한다. */
const isNew = (id: string) => id.startsWith('new-')

function blankQuestion(type: QuestionType, position: number): Question {
  return {
    id: `new-${crypto.randomUUID()}`,
    quiz_id: '',
    position,
    type,
    prompt: '',
    choices: type === 'mcq' ? ['', '', '', ''] : null,
    correct_choice: type === 'mcq' ? 0 : null,
    model_answer: type === 'short' ? '' : null,
    rubric: type === 'short' ? '' : null,
    points: 1,
  }
}

export default function ReviewPage() {
  const { id: quizId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [deletedIds, setDeletedIds] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!quizId) return
    const [{ data: q, error: qErr }, { data: qs }] = await Promise.all([
      supabase.from('quiz_quizzes').select('*').eq('id', quizId).single(),
      supabase.from('quiz_questions').select('*').eq('quiz_id', quizId).order('position'),
    ])
    if (qErr || !q) {
      setError(qErr?.message ?? '퀴즈를 찾을 수 없습니다.')
      setLoading(false)
      return
    }
    setQuiz(q as Quiz)
    setQuestions((qs ?? []) as Question[])
    setDeletedIds([])
    setDirty(false)
    setLoading(false)
  }, [quizId])

  useEffect(() => {
    void load()
  }, [load])

  // 생성 중이면 완료될 때까지 폴링 (다른 화면에서 돌아온 경우 대비)
  useEffect(() => {
    if (quiz?.status !== 'generating') {
      if (pollRef.current) window.clearInterval(pollRef.current)
      return
    }
    pollRef.current = window.setInterval(() => void load(), 3000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [quiz?.status, load])

  function patch(index: number, changes: Partial<Question>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...changes } : q)))
    setDirty(true)
  }

  function remove(index: number) {
    const q = questions[index]
    if (!isNew(q.id)) setDeletedIds((prev) => [...prev, q.id])
    setQuestions((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= questions.length) return
    setQuestions((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setDirty(true)
  }

  function add(type: QuestionType) {
    setQuestions((prev) => [...prev, blankQuestion(type, prev.length)])
    setDirty(true)
  }

  function validate(): string | null {
    if (questions.length === 0) return '문항이 하나도 없습니다.'
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const n = i + 1
      if (!q.prompt.trim()) return `${n}번 문항의 지문이 비어 있습니다.`
      if (q.points <= 0) return `${n}번 문항의 배점은 0보다 커야 합니다.`
      if (q.type === 'mcq') {
        const choices = (q.choices ?? []).map((c) => c.trim())
        if (choices.length < 2) return `${n}번 문항의 보기는 2개 이상이어야 합니다.`
        if (choices.some((c) => !c)) return `${n}번 문항에 비어 있는 보기가 있습니다.`
        if (q.correct_choice == null || q.correct_choice < 0 || q.correct_choice >= choices.length)
          return `${n}번 문항의 정답을 선택하세요.`
      } else if (!q.model_answer?.trim()) {
        return `${n}번 문항의 모범답안이 비어 있습니다. AI 채점의 기준이 됩니다.`
      }
    }
    return null
  }

  async function save(): Promise<boolean> {
    if (!quizId) return false
    const problem = validate()
    if (problem) {
      setError(problem)
      return false
    }
    setError('')
    setSaving(true)
    try {
      if (deletedIds.length > 0) {
        const { error: delErr } = await supabase.from('quiz_questions').delete().in('id', deletedIds)
        if (delErr) throw delErr
      }

      const rows = questions.map((q, i) => ({
        quiz_id: quizId,
        position: i,
        type: q.type,
        prompt: q.prompt.trim(),
        choices: q.type === 'mcq' ? (q.choices ?? []).map((c) => c.trim()) : null,
        correct_choice: q.type === 'mcq' ? q.correct_choice : null,
        model_answer: q.type === 'short' ? (q.model_answer ?? '').trim() : null,
        rubric: q.type === 'short' ? (q.rubric ?? '').trim() || null : null,
        points: q.points,
      }))

      const updates = questions
        .map((q, i) => ({ ...rows[i], id: q.id }))
        .filter((r) => !isNew(r.id))
      const inserts = questions.map((q, i) => ({ q, row: rows[i] })).filter((x) => isNew(x.q.id))

      if (updates.length > 0) {
        const { error: upErr } = await supabase.from('quiz_questions').upsert(updates)
        if (upErr) throw upErr
      }
      if (inserts.length > 0) {
        const { error: insErr } = await supabase
          .from('quiz_questions')
          .insert(inserts.map((x) => x.row))
        if (insErr) throw insErr
      }

      await supabase
        .from('quiz_quizzes')
        .update({
          mcq_count: questions.filter((q) => q.type === 'mcq').length,
          short_count: questions.filter((q) => q.type === 'short').length,
        })
        .eq('id', quizId)

      await load()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function publish() {
    if (dirty && !(await save())) return
    if (!dirty) {
      const problem = validate()
      if (problem) {
        setError(problem)
        return
      }
    }
    setSaving(true)
    const { error: rpcErr } = await supabase.rpc('quiz_publish', { p_quiz_id: quizId })
    setSaving(false)
    if (rpcErr) {
      setError(
        rpcErr.message.includes('NO_QUESTIONS')
          ? '문항이 없어 배포할 수 없습니다.'
          : rpcErr.message.includes('FORBIDDEN')
            ? '이 퀴즈를 배포할 권한이 없습니다.'
            : rpcErr.message,
      )
      return
    }
    navigate(`/quiz/${quizId}/share`)
  }

  async function regenerate() {
    if (!quiz) return
    if (
      questions.length > 0 &&
      !window.confirm('기존 문항을 모두 지우고 다시 만듭니다. 계속할까요?')
    )
      return
    setRegenerating(true)
    setError('')
    const { error: fnErr } = await supabase.functions.invoke('generate-quiz', {
      body: {
        quiz_id: quiz.id,
        mcq_count: quiz.mcq_count,
        short_count: quiz.short_count,
        difficulty: quiz.difficulty,
      },
    })
    setRegenerating(false)
    if (fnErr) {
      setError(`문항 생성 실패: ${await readFunctionError(fnErr)}`)
      return
    }
    await load()
  }

  if (loading) return <Loading />
  if (!quiz) return <Page title="오류"><ErrorBox>{error || '퀴즈를 찾을 수 없습니다.'}</ErrorBox></Page>

  if (quiz.status === 'generating') {
    return (
      <Page title={quiz.title}>
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <Spinner className="h-8 w-8 text-indigo-600" />
          <p className="font-medium">자료를 읽고 문제를 만들고 있습니다…</p>
          <p className="text-sm text-slate-500">완료되면 자동으로 넘어갑니다.</p>
        </Card>
      </Page>
    )
  }

  return (
    <Page
      title={quiz.title}
      subtitle={`${questions.length}문항 · ${questions.reduce((s, q) => s + Number(q.points), 0)}점`}
      back={
        <Link to="/" className="text-slate-400 hover:text-slate-600" aria-label="뒤로">
          ←
        </Link>
      }
      right={quiz.status === 'published' ? <Badge tone="green">배포됨</Badge> : undefined}
    >
      {quiz.error_message && (
        <div className="mb-4">
          <ErrorBox>지난 생성 시도 실패: {quiz.error_message}</ErrorBox>
        </div>
      )}

      {questions.length === 0 ? (
        <Card className="space-y-3 py-10 text-center">
          <p className="font-medium text-slate-700">아직 문항이 없습니다.</p>
          <Button onClick={regenerate} loading={regenerating}>
            AI로 다시 만들기
          </Button>
        </Card>
      ) : (
        <ul className="space-y-3">
          {questions.map((q, i) => (
            <li key={q.id}>
              <QuestionCard
                q={q}
                index={i}
                total={questions.length}
                onChange={(changes) => patch(i, changes)}
                onRemove={() => remove(i)}
                onMove={(d) => move(i, d)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => add('mcq')}>
          + 객관식 추가
        </Button>
        <Button variant="secondary" onClick={() => add('short')}>
          + 주관식 추가
        </Button>
      </div>

      {questions.length > 0 && (
        <div className="mt-2">
          <Button variant="ghost" full onClick={regenerate} loading={regenerating}>
            AI로 전체 다시 만들기
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      {/* 하단 고정 액션 바 */}
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {dirty ? '변경사항 저장' : '저장됨'}
          </Button>
          <Button className="flex-1" onClick={publish} loading={saving}>
            {quiz.status === 'published' ? '수정사항 반영' : '배포하기'}
          </Button>
        </div>
      </div>
    </Page>
  )
}

function QuestionCard({
  q,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  q: Question
  index: number
  total: number
  onChange: (changes: Partial<Question>) => void
  onRemove: () => void
  onMove: (delta: number) => void
}) {
  const choices = q.choices ?? []

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-slate-400">{index + 1}</span>
        <Badge tone={q.type === 'mcq' ? 'indigo' : 'amber'}>
          {q.type === 'mcq' ? '객관식' : '주관식'}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="위로"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="아래로"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="삭제"
            onClick={onRemove}
            className="h-8 w-8 rounded-lg text-red-400 hover:bg-red-50"
          >
            ✕
          </button>
        </div>
      </div>

      <Textarea
        rows={2}
        value={q.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder="문제 지문"
      />

      {q.type === 'mcq' ? (
        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-500">
            보기 (동그라미를 눌러 정답 지정)
          </span>
          {choices.map((c, ci) => (
            <div key={ci} className="flex items-center gap-2">
              <input
                type="radio"
                name={`correct-${q.id}`}
                checked={q.correct_choice === ci}
                onChange={() => onChange({ correct_choice: ci })}
                className="h-5 w-5 shrink-0 accent-indigo-600"
                aria-label={`${ci + 1}번 보기를 정답으로`}
              />
              <input
                value={c}
                onChange={(e) =>
                  onChange({ choices: choices.map((v, vi) => (vi === ci ? e.target.value : v)) })
                }
                placeholder={`보기 ${ci + 1}`}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-2 outline-none focus:border-indigo-500"
              />
              {choices.length > 2 && (
                <button
                  type="button"
                  aria-label={`보기 ${ci + 1} 삭제`}
                  onClick={() => {
                    const next = choices.filter((_, vi) => vi !== ci)
                    const correct = q.correct_choice ?? 0
                    onChange({
                      choices: next,
                      correct_choice: correct > ci ? correct - 1 : Math.min(correct, next.length - 1),
                    })
                  }}
                  className="h-8 w-8 shrink-0 rounded-lg text-slate-400 hover:bg-slate-100"
                >
                  −
                </button>
              )}
            </div>
          ))}
          {choices.length < 6 && (
            <button
              type="button"
              onClick={() => onChange({ choices: [...choices, ''] })}
              className="text-sm text-indigo-600 hover:underline"
            >
              + 보기 추가
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            label="모범답안"
            rows={2}
            value={q.model_answer ?? ''}
            onChange={(e) => onChange({ model_answer: e.target.value })}
            hint="AI가 이 답안과 비교해 채점합니다."
          />
          <Input
            label="채점 기준 (선택)"
            value={q.rubric ?? ''}
            onChange={(e) => onChange({ rubric: e.target.value })}
            placeholder="예: '엽록체'와 '빛'이 모두 나오면 정답"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">배점</span>
        <input
          type="number"
          min={1}
          value={q.points}
          onChange={(e) => onChange({ points: Math.max(1, Number(e.target.value) || 1) })}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
        />
      </div>
    </Card>
  )
}
