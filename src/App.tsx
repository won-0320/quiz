import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './lib/auth'
import { Loading } from './components/ui'
import LoginPage from './pages/LoginPage'
import QuizListPage from './pages/QuizListPage'
import NewQuizPage from './pages/NewQuizPage'
import ReviewPage from './pages/ReviewPage'
import SharePage from './pages/SharePage'
import ResultsPage from './pages/ResultsPage'
import JoinPage from './pages/JoinPage'
import TakeQuizPage from './pages/TakeQuizPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* 학생 (로그인 불필요) */}
          <Route path="/j" element={<JoinPage />} />
          <Route path="/j/:code" element={<TakeQuizPage />} />

          {/* 교사 */}
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <QuizListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/new"
            element={
              <RequireAuth>
                <NewQuizPage />
              </RequireAuth>
            }
          />
          <Route
            path="/quiz/:id/review"
            element={
              <RequireAuth>
                <ReviewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/quiz/:id/share"
            element={
              <RequireAuth>
                <SharePage />
              </RequireAuth>
            }
          />
          <Route
            path="/quiz/:id/results"
            element={
              <RequireAuth>
                <ResultsPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
