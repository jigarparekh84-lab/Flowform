import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthCallback } from './components/AuthCallback'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { FlowformProvider } from './state/FlowformContext'
import { AuthProvider } from './state/auth'
import { bootstrapTheme } from './state/theme'
import { installWorkspaceSync } from './data/workspaceSync'
import { initErrorReporting } from './data/reporting'

bootstrapTheme()

// No DSN -> nothing is sent and the Sentry chunk is never fetched (CR-003).
// Errors caught before the SDK finishes loading are buffered inside the seam.
void initErrorReporting()

// The callback page only finishes a sign-in; booting workspace sync there would
// probe /v1 without a session and flash a misleading "not signed in" banner.
const onAuthCallback = window.location.pathname === '/auth/callback'
if (!onAuthCallback) installWorkspaceSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {onAuthCallback ? (
        <AuthCallback />
      ) : (
        <AuthProvider>
          <FlowformProvider>
            <App />
          </FlowformProvider>
        </AuthProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
)
