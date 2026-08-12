export type QuizStatus = 'generating' | 'draft' | 'published'
export type QuestionType = 'mcq' | 'short'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type GradedBy = 'auto' | 'ai' | 'teacher'

export interface Quiz {
  id: string
  teacher_id: string
  title: string
  source_path: string | null
  join_code: string | null
  status: QuizStatus
  mcq_count: number
  short_count: number
  difficulty: Difficulty
  allow_retake: boolean
  error_message: string | null
  created_at: string
  published_at: string | null
}

export interface Question {
  id: string
  quiz_id: string
  position: number
  type: QuestionType
  prompt: string
  /** 객관식 보기. 주관식이면 null */
  choices: string[] | null
  /** 정답 보기의 0-based 인덱스. 주관식이면 null */
  correct_choice: number | null
  model_answer: string | null
  rubric: string | null
  points: number
}

/** 학생에게 내려가는 문항 — 정답 관련 필드가 없다 */
export interface StudentQuestion {
  id: string
  position: number
  type: QuestionType
  prompt: string
  choices: string[] | null
  points: number
}

export interface StudentQuiz {
  quiz_id: string
  title: string
  allow_retake: boolean
  questions: StudentQuestion[]
}

export interface Attempt {
  id: string
  quiz_id: string
  student_name: string
  started_at: string
  submitted_at: string | null
  score: number
  max_score: number
  grading_status: 'pending' | 'done'
}

export interface Answer {
  id: string
  attempt_id: string
  question_id: string
  response: string | null
  is_correct: boolean | null
  awarded_points: number
  ai_reason: string | null
  graded_by: GradedBy | null
}

export interface AttemptResult {
  attempt_id: string
  score: number
  max_score: number
  grading_status: 'pending' | 'done'
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '쉬움',
  medium: '보통',
  hard: '어려움',
}
