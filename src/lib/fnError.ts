/** Supabase Edge Function 오류에서 사람이 읽을 수 있는 메시지를 뽑아낸다. */
export async function readFunctionError(err: unknown): Promise<string> {
  const anyErr = err as { context?: Response; message?: string }
  if (anyErr?.context && typeof anyErr.context.text === 'function') {
    try {
      const text = await anyErr.context.text()
      try {
        const json = JSON.parse(text) as { error?: string }
        if (json.error) return json.error
      } catch {
        /* JSON이 아니면 원문을 그대로 쓴다 */
      }
      if (text) return text
    } catch {
      /* 본문을 못 읽으면 아래 기본 메시지로 */
    }
  }
  return anyErr?.message ?? '알 수 없는 오류'
}
