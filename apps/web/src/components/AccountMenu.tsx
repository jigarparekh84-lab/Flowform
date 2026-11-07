import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../state/auth'

const ROLE_LABEL: Record<string, string> = {
  viewer: 'Viewer · read-only',
  editor: 'Editor · model and run',
  admin: 'Admin · delete and manage',
  owner: 'Owner · full control',
}

function initials(email: string | null): string {
  const name = (email ?? '').split('@')[0] ?? ''
  const parts = name.split(/[._-]+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function until(ms: number): string {
  const left = Math.max(0, ms - Date.now())
  if (left < 60_000) return 'less than a minute'
  const mins = Math.round(left / 60_000)
  return mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`
}

/** Sign-in / account / organization surface for the top chrome. */
export function AccountMenu() {
  const {
    phase,
    config,
    session,
    organizations,
    organizationsDegraded,
    role,
    email,
    busy,
    error,
    signIn,
    signOut,
    refresh,
    reloadOrganizations,
    switchOrg,
    dismissError,
  } = useAuth()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function onSwitch(id: string) {
    setSwitching(id)
    await switchOrg(id)
    setSwitching(null)
  }

  const devAuth = Boolean(config?.devAuth)
  const label =
    phase === 'signedIn'
      ? `${email ?? 'Account'} · ${ROLE_LABEL[role ?? ''] ?? role ?? 'member'}`
      : phase === 'anonymous'
        ? 'Sign in'
        : phase === 'loading'
          ? 'Connecting…'
          : devAuth
            ? 'Dev auth' // CR-012: make the header bypass obvious, not a hidden mode
            : 'Local workspace'

  return (
    <div className="auth-menu" ref={box}>
      <button
        type="button"
        className={`auth-trigger${phase === 'signedIn' ? ' is-signed-in' : ''}${devAuth ? ' is-warn' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={devAuth ? (config?.warning ?? label) : label}
        data-testid="account-trigger"
      >
        {phase === 'signedIn' ? (
          <span className="auth-avatar" aria-hidden>
            {initials(email)}
          </span>
        ) : (
          <span className="auth-avatar auth-avatar-empty" aria-hidden>
            {phase === 'anonymous' ? '→' : '◌'}
          </span>
        )}
        <span className="auth-trigger-label">
          {phase === 'signedIn' ? (role ? ROLE_LABEL[role]?.split(' · ')[0] ?? role : 'Account') : label}
        </span>
      </button>

      {open && (
        <div className="auth-popover" role="dialog" aria-label="Account and workspace">
          {error && (
            <div className="auth-error" role="alert">
              <span>{error}</span>
              <button type="button" className="auth-link" onClick={dismissError}>
                Dismiss
              </button>
            </div>
          )}

          {phase === 'signedIn' && (
            <>
              <div className="auth-identity">
                <span className="auth-avatar" aria-hidden>
                  {initials(email)}
                </span>
                <div>
                  <strong>{email ?? 'Signed in'}</strong>
                  <span className={`auth-role role-${role ?? 'viewer'}`}>{ROLE_LABEL[role ?? ''] ?? role ?? 'member'}</span>
                </div>
              </div>

              {!session?.organizationId && (
                <p className="auth-note warn">
                  This account has no active organization, so workspace saves will be refused. Pick one below or ask
                  your admin for access.
                </p>
              )}

              <div className="auth-section">
                <div className="auth-section-head">
                  <span>Organization</span>
                  <button type="button" className="auth-link" onClick={() => void reloadOrganizations()} disabled={busy}>
                    Refresh
                  </button>
                </div>
                {organizations.length === 0 && <p className="auth-note">No organizations found for this account.</p>}
                <ul className="auth-orgs">
                  {organizations.map((o) => (
                    <li key={o.id} className={o.current ? 'is-current' : ''}>
                      <div>
                        <strong>{o.name}</strong>
                        <span className="auth-org-role">{ROLE_LABEL[o.role]?.split(' · ')[0] ?? o.role}</span>
                      </div>
                      {o.current ? (
                        <span className="auth-current">Current</span>
                      ) : (
                        <button
                          type="button"
                          className="btn ghost btn-tiny"
                          disabled={busy || switching === o.id}
                          onClick={() => void onSwitch(o.id)}
                        >
                          {switching === o.id ? 'Switching…' : 'Switch'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {organizationsDegraded && (
                  <p className="auth-note warn">
                    The identity provider could not list your organizations; showing the current workspace only.
                  </p>
                )}
              </div>

              <div className="auth-section">
                <div className="auth-section-head">
                  <span>Session</span>
                  <span className="auth-muted">
                    {session ? `expires in ${until(session.expiresAt)}` : 'no session'}
                  </span>
                </div>
                <div className="auth-actions">
                  <button type="button" className="btn ghost btn-tiny" onClick={() => void refresh()} disabled={busy}>
                    {busy ? 'Refreshing…' : 'Refresh session'}
                  </button>
                  <button type="button" className="btn ghost btn-tiny" onClick={() => void signOut()} disabled={busy}>
                    Sign out
                  </button>
                </div>
              </div>
            </>
          )}

          {phase === 'anonymous' && (
            <div className="auth-section">
              <p className="auth-note">
                Sign in to save projects to your workspace and share them with your team. Until then this browser keeps
                the only copy.
              </p>
              <button type="button" className="btn primary" onClick={() => void signIn()} disabled={busy}>
                {busy ? 'Opening sign-in…' : 'Sign in'}
              </button>
            </div>
          )}

          {phase === 'local' && (
            <div className="auth-section">
              {config?.devAuth ? (
                <>
                  <p className="auth-note warn" role="alert">
                    {config.warning ??
                      'Development auth bypass is active. Do not use this server outside a developer machine.'}
                  </p>
                  <p className="auth-note">
                    Requests from this machine act as the dev identity (owner by default); no sign-in is needed.
                  </p>
                </>
              ) : (
                <>
                  <p className="auth-note">
                    Authentication is off on this server (<code>AUTH_MODE={config?.mode ?? 'off'}</code>), so
                    workspace saves are rejected and projects stay in this browser.
                  </p>
                  <p className="auth-note">
                    Set <code>AUTH_MODE=workos</code> with <code>WORKOS_API_KEY</code> and <code>WORKOS_CLIENT_ID</code>{' '}
                    to turn on sign-in.
                  </p>
                </>
              )}
            </div>
          )}

          {phase === 'loading' && <p className="auth-note">Checking the workspace session…</p>}
        </div>
      )}
    </div>
  )
}
