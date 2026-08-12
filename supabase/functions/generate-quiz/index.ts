// PDF에서 퀴즈 문항을 생성한다.
//
// 인증: 호출자의 JWT를 그대로 Supabase 클라이언트에 넘긴다. 따라서 RLS가
// "이 퀴즈의 교사 본인인가"를 대신 판정한다 — 별도 소유권 검사 코드가 필요 없고,
// service role 키도 쓰지 않는다.
//
// ANTHROPIC_API_KEY 가 없거나 MOCK_AI=true 이면 mock 문항을 만든다.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MODEL = 'claude-opus-5'

interface Body {
  quiz_id?: string
  mcq_count?: number
  short_count?: number
  difficulty?: 'easy' | 'medium' | 'hard'
  extra_instructions?: string
}

interface GeneratedQuestion {
  type: 'mcq' | 'short'
  prompt: string
  choices: string[]
  correct_choice: number
  model_answer: string
  rubric: string
}

const DIFFICULTY_KO: Record<string, string> = {
  easy: '쉬움 (자료에 그대로 적힌 사실 확인 위주)',
  medium: '보통 (개념 이해와 간단한 적용)',
  hard: '어려움 (여러 개념을 엮은 적용·분석)',
}

/** 구조화 출력 스키마 — 프롬프트로 JSON을 부탁하지 않고 형식을 강제한다. */
const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mcq', 'short'] },
          prompt: { type: 'string' },
          // 주관식이면 빈 배열, 객관식이면 4개
          choices: { type: 'array', items: { type: 'string' } },
          // 주관식이면 -1, 객관식이면 정답 보기의 0-based 인덱스
          correct_choice: { type: 'integer' },
          // 객관식이면 빈 문자열
          model_answer: { type: 'string' },
          rubric: { type: 'string' },
        },
        required: ['type', 'prompt', 'choices', 'correct_choice', 'model_answer', 'rubric'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** SSE 스트림을 읽어 최종 텍스트와 stop_reason 을 모은다. */
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
        if (err instanceof SyntaxError) continue // 잘린 조각은 건너뛴다
        throw err
      }
    }
  }
  return { text, stopReason }
}

function mockQuestions(mcq: number, short: number, title: string): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = []
  for (let i = 0; i < mcq; i++) {
    out.push({
      type: 'mcq',
      prompt: `[샘플 ${i + 1}] "${title}" 자료의 핵심 개념으로 옳은 것은?`,
      choices: ['첫 번째 보기', '두 번째 보기 (정답)', '세 번째 보기', '네 번째 보기'],
      correct_choice: 1,
      model_answer: '',
      rubric: '',
    })
  }
  for (let i = 0; i < short; i++) {
    out.push({
      type: 'short',
      prompt: `[샘플 ${i + 1}] "${title}" 자료에서 배운 내용을 한 문장으로 설명하시오.`,
      choices: [],
      correct_choice: -1,
      model_answer: '자료의 핵심 개념을 정확히 서술하면 정답으로 인정한다.',
      rubric: '핵심 용어가 포함되어 있으면 정답',
    })
  }
  return out
}

async function generateWithClaude(
  apiKey: string,
  pdfBase64: string,
  mcq: number,
  short: number,
  difficulty: string,
  extra: string | undefined,
): Promise<GeneratedQuestion[]> {
  const instruction = [
    `첨부한 수업 자료를 읽고 학생용 퀴즈를 만들어 주세요.`,
    ``,
    `- 객관식 ${mcq}문항, 주관식 ${short}문항 (정확히 이 개수)`,
    `- 난이도: ${DIFFICULTY_KO[difficulty] ?? DIFFICULTY_KO.medium}`,
    `- 모든 문항은 첨부 자료의 내용만으로 풀 수 있어야 합니다. 자료에 없는 내용은 묻지 마세요.`,
    `- 객관식은 보기 4개, choices 에 담고 correct_choice 에 정답 인덱스(0부터)를 넣으세요. model_answer 와 rubric 은 빈 문자열로 두세요.`,
    `- 오답 보기도 그럴듯해야 합니다. "모두 정답", "정답 없음" 같은 보기는 쓰지 마세요.`,
    `- 주관식은 choices 를 빈 배열, correct_choice 를 -1 로 두고, model_answer 에 한두 문장짜리 모범답안을, rubric 에 채점 시 반드시 확인할 핵심 요소를 적으세요.`,
    `- 문항은 쉬운 것부터 어려운 순서로 배열하세요.`,
    `- 모든 문장은 한국어로, 학생이 바로 읽을 수 있는 말투로 쓰세요.`,
    extra ? `\n교사의 추가 요청: ${extra}` : '',
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
      max_tokens: 16000,
      stream: true,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: instruction },
          ],
        },
      ],
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 500)}`)
  }

  const { text, stopReason } = await readClaudeStream(res)

  if (stopReason === 'refusal') {
    throw new Error('AI가 이 자료로 문제 만들기를 거부했습니다. 다른 자료를 사용해 주세요.')
  }
  if (stopReason === 'max_tokens') {
    throw new Error('문항이 너무 길어 응답이 잘렸습니다. 문항 수를 줄여서 다시 시도해 주세요.')
  }
  if (!text.trim()) throw new Error('AI 응답이 비어 있습니다.')

  const parsed = JSON.parse(text) as { questions?: GeneratedQuestion[] }
  if (!parsed.questions?.length) throw new Error('AI가 문항을 만들지 못했습니다.')
  return parsed.questions
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  let quizId: string | undefined
  let supabase: ReturnType<typeof createClient> | undefined

  try {
    const body = (await req.json()) as Body
    quizId = body.quiz_id
    if (!quizId) return json({ error: 'quiz_id 가 필요합니다.' }, 400)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: '인증이 필요합니다.' }, 401)

    // 호출자 권한 그대로 사용 → RLS가 소유권을 검증한다
    supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: quiz, error: quizErr } = await supabase
      .from('quiz_quizzes')
      .select('id, title, source_path, mcq_count, short_count, difficulty')
      .eq('id', quizId)
      .single()

    if (quizErr || !quiz) {
      return json({ error: '퀴즈를 찾을 수 없거나 권한이 없습니다.' }, 403)
    }

    const mcq = Math.max(0, Number(body.mcq_count ?? quiz.mcq_count) || 0)
    const short = Math.max(0, Number(body.short_count ?? quiz.short_count) || 0)
    if (mcq + short < 1) return json({ error: '문항 수가 0입니다.' }, 400)
    if (mcq + short > 30) return json({ error: '문항은 최대 30개까지 만들 수 있습니다.' }, 400)

    await supabase
      .from('quiz_quizzes')
      .update({ status: 'generating', error_message: null })
      .eq('id', quizId)

    const difficulty = String(body.difficulty ?? quiz.difficulty ?? 'medium')
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    const useMock = Deno.env.get('MOCK_AI') === 'true' || !apiKey

    let generated: GeneratedQuestion[]
    if (useMock) {
      generated = mockQuestions(mcq, short, String(quiz.title))
    } else {
      if (!quiz.source_path) return json({ error: 'PDF가 업로드되지 않았습니다.' }, 400)
      const { data: file, error: dlErr } = await supabase.storage
        .from('quiz-pdfs')
        .download(String(quiz.source_path))
      if (dlErr || !file) throw new Error(`PDF를 읽지 못했습니다: ${dlErr?.message ?? '알 수 없음'}`)

      const pdfBase64 = toBase64(new Uint8Array(await file.arrayBuffer()))
      generated = await generateWithClaude(
        apiKey!,
        pdfBase64,
        mcq,
        short,
        difficulty,
        body.extra_instructions,
      )
    }

    // 정규화 — AI가 규칙을 살짝 어겨도 DB 제약을 넘지 않도록 다듬는다
    const rows = generated
      .map((g, i) => {
        const isMcq = g.type === 'mcq'
        const choices = (g.choices ?? []).map((c) => String(c).trim()).filter(Boolean)
        if (isMcq && choices.length < 2) return null
        if (!String(g.prompt ?? '').trim()) return null
        return {
          quiz_id: quizId,
          position: i,
          type: isMcq ? 'mcq' : 'short',
          prompt: String(g.prompt).trim(),
          choices: isMcq ? choices : null,
          correct_choice: isMcq
            ? Math.min(Math.max(0, Number(g.correct_choice) || 0), choices.length - 1)
            : null,
          model_answer: isMcq ? null : String(g.model_answer ?? '').trim() || '(모범답안을 입력하세요)',
          rubric: isMcq ? null : String(g.rubric ?? '').trim() || null,
          points: 1,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (rows.length === 0) throw new Error('쓸 수 있는 문항이 하나도 만들어지지 않았습니다.')

    // 이전 문항 교체
    const { error: delErr } = await supabase.from('quiz_questions').delete().eq('quiz_id', quizId)
    if (delErr) throw delErr
    const { error: insErr } = await supabase.from('quiz_questions').insert(rows)
    if (insErr) throw insErr

    await supabase
      .from('quiz_quizzes')
      .update({
        status: 'draft',
        error_message: null,
        mcq_count: rows.filter((r) => r.type === 'mcq').length,
        short_count: rows.filter((r) => r.type === 'short').length,
      })
      .eq('id', quizId)

    return json({ ok: true, count: rows.length, mock: useMock })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('generate-quiz failed:', message)
    if (supabase && quizId) {
      await supabase
        .from('quiz_quizzes')
        .update({ status: 'draft', error_message: message.slice(0, 500) })
        .eq('id', quizId)
    }
    return json({ error: message }, 500)
  }
})
