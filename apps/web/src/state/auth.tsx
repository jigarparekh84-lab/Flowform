import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { setAuthTokenProvider } from '../data/apiAuth'
import {
  can as canRole,
  getAuthConfig,
  getSession,
  listOrganizations,
  loadAuthConfig,
  refreshSession,
  restoreSession,
  sessionPhase,
  signOut as endSession,
  startSignIn,
  subscribeSession,
  switchOrganization,
  type AuthConfig,
  type Organization,
  type Session,
  type SessionPhase,
  type Role,
  type SignInOptions,
} from '../data/session'
import { probeWorkspace } from '../data/workspaceSync'

type AuthContextValue = {
  phase: SessionPhase
  config: AuthConfig | null
  session: Session | null
  organizations: Organization[]
  organizationsDegraded: boolean
  role: string | null
  email: string | null
  busy: boolean
  error: string | null
  signIn: (opts?: SignInOptions) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  reloadOrganizations: () => Promise<void>
  switchOrg: (organizationId: string) => Promise<void>
  /** Local/dev mode never gates actions; a signed-in session is held to its role. */
  can: (need: Role) => boolean
  dismissError: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [session, setSession] = useState<Session | null>(getSession())
  const [phase, setPhase] = useState<SessionPhase>('loading')
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [organizationsDegraded, setOrganizationsDegraded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      subscribeSession((s) => {
        setSession(s)
        setPhase(sessionPhase(getAuthConfig()))
      }),
    [],
  )

  const loadOrganizations = useCallback(async () => {
    try {
      const out = await listOrganizations()
      setOrganizations(out.organizations)
      setOrganizationsDegraded(out.degraded)
    } catch {
      setOrganizations([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setAuthTokenProvider(() => getSession()?.accessToken ?? null)
    void (async () => {
      try {
        const cfg = await loadAuthConfig(true)
        if (cancelled) return
        setConfig(cfg)
        if (cfg.workosEnabled) await restoreSession()
        if (!cancelled) setPhase(sessionPhase(cfg))
      } catch (e) {
        // The API may be down; the studio still works locally.
        if (cancelled) return
        setError(message(e))
        setPhase('local')
      }
    })()
    return () => {
      cancelled = true
      setAuthTokenProvider(null)
    }
  }, [])

  // Once a session exists, the workspace probe can succeed where the anonymous
  // boot probe could not, so the sync banner reflects reality.
  useEffect(() => {
    if (!session) return
    void probeWorkspace()
    void loadOrganizations()
  }, [session?.organizationId, session?.tenantId, loadOrganizations])

  const signIn = useCallback(async (opts: SignInOptions = {}) => {
    setBusy(true)
    setError(null)
    try {
      await startSignIn(opts)
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await endSession()
      setOrganizations([])
      setError(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await refreshSession()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const switchOrg = useCallback(async (organizationId: string) => {
    setBusy(true)
    setError(null)
    try {
      await switchOrganization(organizationId)
      await loadOrganizations()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }, [loadOrganizations])

  const value = useMemo<AuthContextValue>(() => {
    const role = session?.role ?? null
    return {
      phase,
      config,
      session,
      organizations,
      organizationsDegraded,
      role,
      email: session?.email ?? null,
      busy,
      error,
      signIn,
      signOut,
      refresh,
      reloadOrganizations: loadOrganizations,
      switchOrg,
      can: (need: Role) => (phase === 'signedIn' ? canRole(role, need) : true),
      dismissError: () => setError(null),
    }
  }, [phase, config, session, organizations, organizationsDegraded, busy, error, signIn, signOut, refresh, loadOrganizations, switchOrg])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
