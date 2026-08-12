import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Page } from '../components/ui'
import type { Quiz } from '../lib/types'

interface Stats {
  count: number
  avgPercent: number | null
}

const STATUS_META: Record<Quiz['status'], { label: string; tone: 'gray' | 'amber' | 'green' }> = {
  generating: { label: '생성 중', tone: 'amber' },
  draft: { label: '검토 대기', tone: 'gray' },
  published: { label: '배포됨', tone: 'green' },
}

export default function QuizListPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [stats, setStats] = useState<Record<string, Stats>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { data: qs, error: qErr } = await supabase
      .from('quiz_quizzes')
      .select('*')
      .order('created_at', { ascending: false })

    if (qErr) {
      setError(qErr.message)
      setLoading(false)
      return
    }
    const list = (qs ?? []) as Quiz[]
    setQuizzes(list)

    if (list.length > 0) {
      const { data: attempts } = await supabase
        .from('quiz_attempts')
        .select('quiz_id, score, max_score')
        .in(
          'quiz_id',
          list.map((q) => q.id),
        )
        .not('submitted_at', 'is', null)

      const agg: Record<string, { n: number; sum: number }> = {}
      for (const a of attempts ?? []) {
        const row = (agg[a.quiz_id] ??= { n: 0, sum: 0 })
        row.n += 1
        row.sum += a.max_score > 0 ? (a.score / a.max_score) * 100 : 0
      }
      setStats(
        Object.fromEntries(
          Object.entries(agg).map(([id, v]) => [
            id,
            { count: v.n, avgPercent: v.n ? Math.round(v.sum / v.n) : null },
          ]),
        ),
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function destinationFor(q: Quiz) {
    if (q.status === 'published') return `/quiz/${q.id}/results`
    return `/quiz/${q.id}/review`
  }

  return (
    <Page
      title="내 퀴즈"
      subtitle={user?.email}
      right={
        <Button
          variant="ghost"
          className="px-2 text-xs"
          onClick={async () => {
            await supabase.auth.signOut()
            navigate('/login', { replace: true })
          }}
        >
          로그아웃
        </Button>
      }
    >
      <Link to="/new" className="mb-4 block">
        <Button full>+ 새 퀴즈 만들기</Button>
      </Link>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading ? (
        <Loading />
      ) : quizzes.length === 0 ? (
        <Empty title="아직 만든 퀴즈가 없습니다">
          수업 자료 PDF를 올리면 문제를 자동으로 만들어 드립니다.
        </Empty>
      ) : (
        <ul className="space-y-3">
          {quizzes.map((q) => {
            const s = stats[q.id]
            const meta = STATUS_META[q.status]
            return (
              <li key={q.id}>
                <Link to={destinationFor(q)}>
                  <Card className="transition-shadow hover:shadow-md">
                    <div className="flex items-start gap-2">
                      <h2 className="min-w-0 flex-1 font-semibold break-words">{q.title}</h2>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span>
                        객관식 {q.mcq_count} · 주관식 {q.short_count}
                      </span>
                      {q.join_code && (
                        <span className="font-mono font-semibold tracking-widest text-indigo-600">
                          {q.join_code}
                        </span>
                      )}
                      {s && (
                        <span>
                          응시 {s.count}명
                          {s.avgPercent !== null && ` · 평균 ${s.avgPercent}%`}
                        </span>
                      )}
                      <span className="ml-auto">
                        {new Date(q.created_at).toLocaleDateString('ko-KR')}
                      </span>
                    </div>
                  </Card>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Page>
  )
}
