import { useEffect, useState } from 'react'
import { completeSignIn, readPendingSignIn } from '../data/session'

type State = { status: 'working' | 'error'; message?: string }

let started = false

/**
 * `/auth/callback` landing page. The server only exchanges the code if the
 * signed state it issued comes back, so this page just hands over code+state and
 * then returns the browser to where sign-in started.
 */
function initialError(): State | null {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('error')
  if (!error) return null
  return { status: 'error', message: params.get('error_description') ?? error }
}

export function AuthCallback() {
  const [state, setState] = useState<State>(() => initialError() ?? { status: 'working' })

  useEffect(() => {
    if (started || state.status === 'error') return
    started = true
    const params = new URLSearchParams(window.location.search)
    const returnTo = readPendingSignIn()?.returnTo ?? '/'
    void completeSignIn({
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error'),
    })
      .then(() => window.location.replace(returnTo.startsWith('/') ? returnTo : '/'))
      .catch((e: unknown) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }))
  }, [state.status])

  return (
    <div className="auth-callback" role="status" aria-live="polite">
      <div className="auth-callback-card">
        {state.status === 'working' ? (
          <>
            <div className="auth-callback-spinner" aria-hidden />
            <h1>Signing you in…</h1>
            <p>Verifying the sign-in state with Flowform.</p>
          </>
        ) : (
          <>
            <h1>Sign-in did not complete</h1>
            <p className="auth-callback-error">{state.message}</p>
            <p className="auth-callback-hint">
              The link may have expired. Start again from the workspace; nothing in this browser was changed.
            </p>
            <a className="btn primary" href="/">
              Back to Flowform
            </a>
          </>
        )}
      </div>
    </div>
  )
}
