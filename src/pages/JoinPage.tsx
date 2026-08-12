import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, Input } from '../components/ui'

export default function JoinPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const clean = code.trim().toUpperCase()
    if (clean.length < 4) return
    navigate(`/j/${clean}`)
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl">✏️</div>
          <h1 className="mt-2 text-2xl font-bold">퀴즈 참여</h1>
          <p className="mt-1 text-sm text-slate-500">선생님이 알려준 참여 코드를 입력하세요</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              className="text-center font-mono text-3xl font-bold tracking-[0.3em] uppercase"
              aria-label="참여 코드"
            />
            <Button type="submit" full disabled={code.trim().length < 4}>
              들어가기
            </Button>
          </form>
        </Card>

        <div className="mt-6 text-center text-sm text-slate-500">
          선생님이신가요?{' '}
          <Link to="/login" className="font-semibold text-indigo-600 hover:underline">
            로그인
          </Link>
        </div>
      </div>
    </div>
  )
}
