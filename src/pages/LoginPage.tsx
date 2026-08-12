import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Button, Card, ErrorBox, Input, Loading } from '../components/ui'

export default function LoginPage() {
  const { user, loading } = useAuth()
  const location = useLocation() as { state?: { from?: string } }
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  if (loading) return <Loading />
  if (user) return <Navigate to={location.state?.from ?? '/'} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (!data.session) {
          setNotice('가입 확인 메일을 보냈습니다. 메일의 링크를 눌러 인증한 뒤 로그인하세요.')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('Invalid login credentials')
          ? '이메일 또는 비밀번호가 올바르지 않습니다.'
          : msg.includes('already registered')
            ? '이미 가입된 이메일입니다. 로그인해 주세요.'
            : msg.includes('Signups not allowed')
              ? '이 서버는 직접 가입이 막혀 있습니다. 관리자에게 계정 생성을 요청하세요. (Supabase 대시보드 → Authentication → Users → Add user)'
              : msg.includes('Email not confirmed')
                ? '메일 인증이 아직 안 됐습니다. 받은 메일의 링크를 눌러 주세요.'
                : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl">📝</div>
          <h1 className="mt-2 text-2xl font-bold">퀴즈 만들기</h1>
          <p className="mt-1 text-sm text-slate-500">PDF를 올리면 퀴즈가 자동으로 만들어집니다</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              label="이메일"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teacher@school.kr"
            />
            <Input
              label="비밀번호"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상"
            />

            {error && <ErrorBox>{error}</ErrorBox>}
            {notice && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
                {notice}
              </div>
            )}

            <Button type="submit" full loading={busy}>
              {mode === 'signin' ? '로그인' : '가입하기'}
            </Button>
          </form>

          <button
            type="button"
            className="mt-3 w-full text-center text-sm text-indigo-600 hover:underline"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              setError('')
              setNotice('')
            }}
          >
            {mode === 'signin' ? '계정이 없으신가요? 교사 가입' : '이미 계정이 있으신가요? 로그인'}
          </button>
        </Card>

        <div className="mt-6 text-center text-sm text-slate-500">
          학생이신가요?{' '}
          <Link to="/j" className="font-semibold text-indigo-600 hover:underline">
            참여 코드 입력하기
          </Link>
        </div>
      </div>
    </div>
  )
}
