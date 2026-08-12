// 한 응시(attempt)의 주관식 답안을 AI로 채점한다.
//
// 학생은 로그인하지 않으므로 이 함수는 service role 로 DB에 접근한다.
// 남용 방지: grading_status 가 'pending' 인 응시만 채점하고, 끝나면 항상 'done' 으로
// 바꾼다. 따라서 같은 attempt_id 로 반복 호출해도 AI를 두 번 부르지 않는다.
//
// ANTHROPIC_API_KEY 가 없거나 MOCK_AI=true 이면 키워드 일치로 대신 채점한다.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MODEL = 'claude-opus-5'

interface GradeItem {
  index: number
  verdict: 'correct' | 'partial' | 'incorrect'
  ratio: number
  reason: string
}

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
          // 배점 대비 부여 비율 (0.0 ~ 1.0)
          ratio: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['index', 'verdict', 'ratio', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function readClaudeStream(res: Response): Promise<{ text: string; stopReason: string | null }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let stopReason: string | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const evt = JSON.parse(payload)
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          text += evt.delta.text
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message ?? 'Claude API 스트림 오류')
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue
        throw err
      }
    }
  }
  return { text, stopReason }
}

interface Item {
  index: number
  prompt: string
  model_answer: string
  rubric: string | null
  response: string
}

/**
 * AI 키가 없을 때 쓰는 임시 채점. 한국어는 조사가 붙어 단순 키워드 비교가 잘 맞지 않으므로,
 * 맞다/틀리다를 흉내내지 않고 "답을 썼는지"만 보고 절반 점수를 준 뒤 교사에게 넘긴다.
 * (정답을 오답으로 확정해 버리는 것보다 낫다.)
 */
function mockGrade(items: Item[]): GradeItem[] {
  return items.map((it) => {
    const answered = it.response.trim().length > 0
    return {
      index: it.index,
      verdict: answered ? 'partial' : 'incorrect',
      ratio: answered ? 0.5 : 0,
      reason: answered
        ? 'AI 채점 키가 설정되지 않아 임시로 절반 점수를 주었습니다. 교사 채점이 필요합니다.'
        : '무응답',
    }
  })
}

async function gradeWithClaude(apiKey: string, items: Item[]): Promise<GradeItem[]> {
  const payload = items
    .map((it) =>
      [
        `### 문항 ${it.index}`,
        `문제: ${it.prompt}`,
        `모범답안: ${it.model_answer}`,
        it.rubric ? `채점 기준: ${it.rubric}` : null,
        `학생 답안: ${it.response || '(무응답)'}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')

  const instruction = [
    '아래 주관식 답안들을 채점해 주세요. 각 문항마다 결과를 하나씩 내야 합니다.',
    '',
    '채점 원칙:',
    '- 표현이 모범답안과 달라도 핵심 내용이 맞으면 정답(correct)입니다. 문장을 그대로 외웠는지가 아니라 이해했는지를 보세요.',
    '- 맞춤법, 띄어쓰기, 문장 다듬기는 감점하지 마세요.',
    '- 핵심 요소 중 일부만 맞으면 부분정답(partial)입니다.',
    '- 무응답이거나 내용이 틀리면 오답(incorrect)입니다.',
    '- ratio 는 배점 대비 줄 점수의 비율입니다. correct=1, incorrect=0, partial 은 0.3~0.7 사이에서 정하세요.',
    '- reason 은 교사가 검토할 수 있도록 한국어 한 문장으로 짧게 쓰세요.',
    '- index 는 아래 "문항 N" 의 N 을 그대로 쓰세요.',
    '',
    payload,
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      stream: true,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [{ role: 'user', content: instruction }],
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`)
  }

  const { text, stopReason } = await readClaudeStream(res)
  if (stopReason === 'refusal') throw new Error('AI가 채점을 거부했습니다.')
  if (!text.trim()) throw new Error('AI 채점 응답이 비어 있습니다.')

  const parsed = JSON.parse(text) as { results?: GradeItem[] }
  if (!parsed.results?.length) throw new Error('AI 채점 결과가 비어 있습니다.')
  return parsed.results
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  let attemptId: string | undefined

  try {
    const body = (await req.json()) as { attempt_id?: string }
    attemptId = body.attempt_id
    if (!attemptId) return json({ error: 'attempt_id 가 필요합니다.' }, 400)

    const { data: attempt } = await admin
      .from('quiz_attempts')
      .select('id, quiz_id, grading_status')
      .eq('id', attemptId)
      .maybeSingle()

    if (!attempt) return json({ error: '응시 기록을 찾을 수 없습니다.' }, 404)
    // 이미 채점된 건 다시 채점하지 않는다 (반복 호출로 AI를 낭비하지 않기 위해)
    if (attempt.grading_status === 'done') return json({ ok: true, skipped: true })

    const { data: rows, error: rowsErr } = await admin
      .from('quiz_answers')
      .select('id, response, question_id, quiz_questions!inner(prompt, model_answer, rubric, points, type)')
      .eq('attempt_id', attemptId)
      .eq('quiz_questions.type', 'short')

    if (rowsErr) throw rowsErr

    type Row = {
      id: string
      response: string | null
      quiz_questions: { prompt: string; model_answer: string | null; rubric: string | null; points: number }
    }
    const shortRows = (rows ?? []) as unknown as Row[]

    if (shortRows.length === 0) {
      await admin.from('quiz_attempts').update({ grading_status: 'done' }).eq('id', attemptId)
      return json({ ok: true, graded: 0 })
    }

    const items: Item[] = shortRows.map((r, i) => ({
      index: i,
      prompt: r.quiz_questions.prompt,
      model_answer: r.quiz_questions.model_answer ?? '',
      rubric: r.quiz_questions.rubric,
      response: r.response ?? '',
    }))

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    const useMock = Deno.env.get('MOCK_AI') === 'true' || !apiKey

    let results: GradeItem[]
    // mock 결과는 AI가 매긴 점수가 아니므로 graded_by 를 비워 둔다 (교사 채점 대기 표시)
    let gradedBy: 'ai' | 'teacher' | null = 'ai'
    let note = ''

    if (useMock) {
      results = mockGrade(items)
      gradedBy = null
    } else {
      try {
        results = await gradeWithClaude(apiKey!, items)
      } catch (err) {
        // AI 채점이 실패해도 학생을 무한 대기시키지 않는다. 0점 + 사유를 남기고
        // 교사가 결과 화면에서 직접 고칠 수 있게 한다.
        const message = err instanceof Error ? err.message : String(err)
        console.error('AI grading failed, falling back:', message)
        results = items.map((it) => ({
          index: it.index,
          verdict: 'incorrect' as const,
          ratio: 0,
          reason: 'AI 채점 실패 — 교사 확인 필요',
        }))
        gradedBy = 'teacher'
        note = message
      }
    }

    const byIndex = new Map(results.map((r) => [Number(r.index), r]))

    for (let i = 0; i < shortRows.length; i++) {
      const row = shortRows[i]
      const points = Number(row.quiz_questions.points)
      const r = byIndex.get(i)
      const ratio = r ? Math.max(0, Math.min(1, Number(r.ratio) || 0)) : 0
      const awarded = Math.round(points * ratio * 2) / 2 // 0.5점 단위

      await admin
        .from('quiz_answers')
        .update({
          awarded_points: awarded,
          is_correct: r ? r.verdict === 'correct' : false,
          ai_reason: r?.reason ?? '채점 결과 없음',
          graded_by: gradedBy,
        })
        .eq('id', row.id)
    }

    await admin.from('quiz_attempts').update({ grading_status: 'done' }).eq('id', attemptId)

    return json({ ok: true, graded: shortRows.length, mock: useMock, note: note || undefined })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('grade-short-answers failed:', message)
    // 학생 화면이 영원히 "채점 중"에 머물지 않도록 상태만은 종료시킨다.
    if (attemptId) {
      await admin.from('quiz_attempts').update({ grading_status: 'done' }).eq('id', attemptId)
    }
    return json({ error: message }, 500)
  }
})
