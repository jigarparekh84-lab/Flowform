import { useEffect, useState } from 'react'
import {
  getSyncStatus,
  localOnlyProjects,
  migrateLocalProjects,
  subscribeSyncStatus,
  type SyncStatus,
} from '../data/workspaceSync'

const LABEL: Record<SyncStatus, string> = {
  disabled: 'Projects are stored in this browser only (server sync disabled).',
  unknown: 'Connecting to your workspace…',
  online: 'Saved to your workspace.',
  offline: 'Workspace unreachable — saving in this browser; changes sync when it is back.',
  unauthorized: 'Not signed in to a workspace — saving in this browser only.',
}

/** FF-107: sync status banner + one-click "move my local projects". */
export function WorkspaceSyncPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus())
  const [localCount, setLocalCount] = useState(() => localOnlyProjects().length)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(
    () =>
      subscribeSyncStatus((s) => {
        setStatus(s)
        setLocalCount(localOnlyProjects().length)
      }),
    [],
  )

  async function migrate() {
    setBusy(true)
    const r = await migrateLocalProjects()
    setBusy(false)
    setLocalCount(localOnlyProjects().length)
    onChanged()
    setMsg(
      r.failed
        ? `Moved ${r.pushed}; ${r.failed} still local (workspace unreachable).`
        : `Moved ${r.pushed} project(s) to your workspace${r.pulled ? `; added ${r.pulled} from it` : ''}.`,
    )
  }

  if (status === 'disabled') return null
  const warn = status === 'offline' || status === 'unauthorized'
  return (
    <div
      className={`workspace-sync ${warn ? 'is-warn' : ''}`}
      role="status"
      style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '8px 12px', margin: '0 0 12px', borderRadius: 8,
        border: `1px solid ${warn ? 'var(--warn, #c98a00)' : 'var(--border, #3334)'}`,
      }}
    >
      <span>{LABEL[status]}</span>
      {status === 'online' && localCount > 0 && (
        <button type="button" className="btn" disabled={busy} onClick={() => void migrate()}>
          {busy ? 'Moving…' : `Move my ${localCount} local project(s) to my workspace`}
        </button>
      )}
      {msg && <span className="muted">{msg}</span>}
    </div>
  )
}
