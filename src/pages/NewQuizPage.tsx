import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Button, Card, ErrorBox, Input, Page, Spinner, Textarea } from '../components/ui'
import { DIFFICULTY_LABEL, type Difficulty } from '../lib/types'
import { readFunctionError } from '../lib/fnError'

const MAX_BYTES = 20 * 1024 * 1024

export default function NewQuizPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [mcqCount, setMcqCount] = useState(5)
  const [shortCount, setShortCount] = useState(2)
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState('')
  const [step, setStep] = useState<'' | 'uploading' | 'generating'>('')

  const busy = step !== ''
  const total = mcqCount + shortCount

  function onPickFile(f: File | null) {
    setError('')
    if (!f) {
      setFile(null)
      return
    }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('PDF 파일만 올릴 수 있습니다.')
      return
    }
    if (f.size > MAX_BYTES) {
      setError(`파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(1)}MB). 20MB 이하로 올려주세요.`)
      return
    }
    setFile(f)
    if (!title.trim()) setTitle(f.name.replace(/\.pdf$/i, ''))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file || !user) return
    if (total < 1) {
      setError('문항을 1개 이상 만들어야 합니다.')
      return
    }
    if (total > 30) {
      setError('한 번에 만들 수 있는 문항은 30개까지입니다.')
      return
    }

    setError('')
    setStep('uploading')

    // 1. 퀴즈 행 먼저 생성 (id가 파일 경로에 필요)
    const { data: quiz, error: insErr } = await supabase
      .from('quiz_quizzes')
      .insert({
        teacher_id: user.id,
        title: title.trim() || file.name.replace(/\.pdf$/i, ''),
        status: 'generating',
        mcq_count: mcqCount,
        short_count: shortCount,
        difficulty,
      })
      .select()
      .single()

    if (insErr || !quiz) {
      setStep('')
      setError(insErr?.message ?? '퀴즈를 만들지 못했습니다.')
      return
    }

    // 2. PDF 업로드 — 경로는 RLS 정책과 맞춰 {uid}/{quiz_id}.pdf
    const path = `${user.id}/${quiz.id}.pdf`
    const { error: upErr } = await supabase.storage
      .from('quiz-pdfs')
      .upload(path, file, { contentType: 'application/pdf', upsert: true })

    if (upErr) {
      await supabase.from('quiz_quizzes').delete().eq('id', quiz.id)
      setStep('')
      setError(`PDF 업로드 실패: ${upErr.message}`)
      return
    }
    await supabase.from('quiz_quizzes').update({ source_path: path }).eq('id', quiz.id)

    // 3. 문항 생성 요청
    setStep('generating')
    const { error: fnErr } = await supabase.functions.invoke('generate-quiz', {
      body: {
        quiz_id: quiz.id,
        mcq_count: mcqCount,
        short_count: shortCount,
        difficulty,
        extra_instructions: instructions.trim() || undefined,
      },
    })

    if (fnErr) {
      // 실패해도 퀴즈 행은 남겨서 검토 화면에서 재시도할 수 있게 한다.
      const message = await readFunctionError(fnErr)
      await supabase
        .from('quiz_quizzes')
        .update({ status: 'draft', error_message: message })
        .eq('id', quiz.id)
      setStep('')
      setError(`문항 생성 실패: ${message}`)
      return
    }

    navigate(`/quiz/${quiz.id}/review`, { replace: true })
  }

  return (
    <Page
      title="새 퀴즈 만들기"
      back={
        <Link to="/" className="text-slate-400 hover:text-slate-600" aria-label="뒤로">
          ←
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">수업 자료 (PDF)</span>
          <label
            className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
              file ? 'border-indigo-300 bg-indigo-50' : 'border-slate-300 hover:bg-slate-50'
            }`}
          >
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              disabled={busy}
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <>
                <span className="text-2xl">📄</span>
                <span className="text-sm font-medium break-all text-slate-800">{file.name}</span>
                <span className="text-xs text-slate-500">
                  {(file.size / 1024 / 1024).toFixed(1)}MB · 다시 누르면 변경
                </span>
              </>
            ) : (
              <>
                <span className="text-2xl">⬆️</span>
                <span className="text-sm font-medium text-slate-700">PDF 파일 선택</span>
                <span className="text-xs text-slate-500">최대 20MB</span>
              </>
            )}
          </label>
        </Card>

        <Card className="space-y-4">
          <Input
            label="퀴즈 제목"
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: 3단원 광합성"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="객관식 개수"
              type="number"
              min={0}
              max={30}
              value={mcqCount}
              disabled={busy}
              onChange={(e) => setMcqCount(Math.max(0, Number(e.target.value) || 0))}
            />
            <Input
              label="주관식 개수"
              type="number"
              min={0}
              max={30}
              value={shortCount}
              disabled={busy}
              onChange={(e) => setShortCount(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <p className="-mt-2 text-xs text-slate-500">총 {total}문항</p>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-slate-700">난이도</span>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={busy}
                  onClick={() => setDifficulty(d)}
                  className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                    difficulty === d
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
          </div>

          <Textarea
            label="추가 요청 (선택)"
            rows={2}
            value={instructions}
            disabled={busy}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="예: 계산 문제 위주로, 3~5쪽 내용만"
          />
        </Card>

        {error && <ErrorBox>{error}</ErrorBox>}

        <Button type="submit" full loading={busy} disabled={!file}>
          {step === 'uploading' ? 'PDF 올리는 중…' : step === 'generating' ? '문항 만드는 중…' : '문항 만들기'}
        </Button>

        {step === 'generating' && (
          <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
            <Spinner className="h-4 w-4" />
            자료를 읽고 문제를 만들고 있습니다. 최대 1~2분 걸릴 수 있어요.
          </div>
        )}
      </form>
    </Page>
  )
}
