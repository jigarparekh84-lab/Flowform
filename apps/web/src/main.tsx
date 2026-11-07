import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthCallback } from './components/AuthCallback'
import { FlowformProvider } from './state/FlowformContext'
import { AuthProvider } from './state/auth'
import { bootstrapTheme } from './state/theme'
import { installWorkspaceSync } from './data/workspaceSync'

bootstrapTheme()

// The callback page only finishes a sign-in; booting workspace sync there would
// probe /v1 without a session and flash a misleading "not signed in" banner.
const onAuthCallback = window.location.pathname === '/auth/callback'
if (!onAuthCallback) installWorkspaceSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {onAuthCallback ? (
      <AuthCallback />
    ) : (
      <AuthProvider>
        <FlowformProvider>
          <App />
        </FlowformProvider>
      </AuthProvider>
    )}
  </StrictMode>,
)
