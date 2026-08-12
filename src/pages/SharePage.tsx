import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { Button, Card, ErrorBox, Loading, Page } from '../components/ui'
import type { Quiz } from '../lib/types'

export default function SharePage() {
  const { id: quizId } = useParams<{ id: string }>()
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [qr, setQr] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'code' | 'link' | ''>('')

  useEffect(() => {
    if (!quizId) return
    supabase
      .from('quiz_quizzes')
      .select('*')
      .eq('id', quizId)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          setError(error?.message ?? '퀴즈를 찾을 수 없습니다.')
          return
        }
        setQuiz(data as Quiz)
      })
  }, [quizId])

  const link = quiz?.join_code ? `${window.location.origin}/j/${quiz.join_code}` : ''

  useEffect(() => {
    if (!link) return
    QRCode.toDataURL(link, { width: 480, margin: 1 })
      .then(setQr)
      .catch(() => setQr(''))
  }, [link])

  async function copy(text: string, what: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied(''), 1800)
    } catch {
      setError('복사에 실패했습니다. 길게 눌러 직접 복사해 주세요.')
    }
  }

  async function toggleRetake() {
    if (!quiz) return
    const next = !quiz.allow_retake
    const { error } = await supabase
      .from('quiz_quizzes')
      .update({ allow_retake: next })
      .eq('id', quiz.id)
    if (error) setError(error.message)
    else setQuiz({ ...quiz, allow_retake: next })
  }

  if (error && !quiz) return <Page title="오류"><ErrorBox>{error}</ErrorBox></Page>
  if (!quiz) return <Loading />

  return (
    <Page
      title="학생에게 공유"
      subtitle={quiz.title}
      back={
        <Link to="/" className="text-slate-400 hover:text-slate-600" aria-label="뒤로">
          ←
        </Link>
      }
    >
      <Card className="text-center">
        <p className="text-sm text-slate-500">참여 코드</p>
        <button
          type="button"
          onClick={() => copy(quiz.join_code ?? '', 'code')}
          className="mt-1 font-mono text-5xl font-black tracking-[0.2em] text-indigo-600 tabular-nums"
        >
          {quiz.join_code}
        </button>
        <p className="mt-1 text-xs text-slate-400">
          {copied === 'code' ? '복사했습니다!' : '눌러서 복사'}
        </p>

        {qr && (
          <img
            src={qr}
            alt="참여 링크 QR 코드"
            className="mx-auto mt-4 h-52 w-52 max-w-full rounded-xl border border-slate-200"
          />
        )}

        <div className="mt-4 space-y-2">
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs break-all text-slate-600">
            {link}
          </div>
          <Button variant="secondary" full onClick={() => copy(link, 'link')}>
            {copied === 'link' ? '링크를 복사했습니다!' : '링크 복사'}
          </Button>
        </div>
      </Card>

      <Card className="mt-3">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium">재응시 허용</span>
            <span className="block text-xs text-slate-500">
              끄면 같은 이름으로 한 번만 제출할 수 있습니다.
            </span>
          </span>
          <input
            type="checkbox"
            checked={quiz.allow_retake}
            onChange={toggleRetake}
            className="h-6 w-6 shrink-0 accent-indigo-600"
          />
        </label>
      </Card>

      {error && (
        <div className="mt-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link to={`/quiz/${quiz.id}/review`}>
          <Button variant="secondary" full>
            문항 수정
          </Button>
        </Link>
        <Link to={`/quiz/${quiz.id}/results`}>
          <Button full>결과 보기</Button>
        </Link>
      </div>
    </Page>
  )
}
