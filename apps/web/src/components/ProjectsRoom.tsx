import { useMemo, useRef, useState } from 'react'
import { downloadProjectFile } from '../data/projects'
import { DecisionLogPanel } from './DecisionLogPanel'
import { WorkspaceSyncPanel } from './WorkspaceSyncPanel'
import { useFlowform } from '../state/FlowformContext'

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function ProjectsRoom() {
  const {
    projectMeta,
    projects,
    activeProjectId,
    createProject,
    renameProject,
    duplicateProject,
    deleteProject,
    switchProject,
    exportActiveProject,
    importProjectFile,
    importEnterprisePack,
    refreshProjects,
  } = useFlowform()

  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const sorted = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [projects],
  )

  function startRename(id: string, name: string) {
    setRenameId(id)
    setRenameValue(name)
  }

  function commitRename() {
    if (!renameId) return
    const ok = renameProject(renameId, renameValue)
    setStatus(ok ? `Renamed to “${renameValue.trim()}”.` : 'Rename failed.')
    setRenameId(null)
  }

  async function onImportFile(file: File | null) {
    if (!file) return
    try {
      const text = await file.text()
      const raw = JSON.parse(text) as unknown
      const meta = importProjectFile(raw)
      setStatus(
        meta
          ? `Imported “${meta.name}” and switched to it.`
          : 'Import failed — not a Flowform project JSON.',
      )
    } catch {
      setStatus('Import failed — invalid JSON.')
    }
  }

  async function loadStressIntoActive(which: '120' | '200' = '200') {
    const file =
      which === '120'
        ? '/samples/stress-120-demand.enterprise.json'
        : '/samples/stress-200-demand.enterprise.json'
    try {
      const res = await fetch(file)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const raw = (await res.json()) as unknown
      const card = importEnterprisePack(raw)
      if (!card) {
        setStatus('Stress pack is not a valid enterprise JSON.')
        return
      }
      if (card.errorCount > 0) {
        setStatus(
          `Stress-${which} blocked — ${card.errorCount} error(s), score ${card.score}.`,
        )
        return
      }
      setStatus(
        `Loaded stress-${which} into Active project · ${card.siteCount} sites · ${card.demandRowCount} demand rows (schema ${card.schemaVersion}). Open Data to review scorecard, then Run.`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'load failed'
      setStatus(`Could not load stress-${which}: ${msg}`)
    }
  }

  return (
    <div className="studio-room projects-room">
      <WorkspaceSyncPanel onChanged={refreshProjects} />
      <header className="studio-header">
        <div>
          <p className="map-kicker">Projects</p>
          <h1>Design studies</h1>
          <p className="studio-sub">
            Create, rename, duplicate, or delete footprint studies. Full state
            (network, scenarios, constraints, data, optional theme) persists in
            this browser and syncs to your workspace when the API is reachable. Export / import JSON to share.
            Load stress-120 / stress-200 enterprise packs into the Active
            project for large MIP benchmarks (also available under Data).
          </p>
        </div>
        <div className="projects-header-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              const meta = createProject()
              setStatus(`Created “${meta.name}”.`)
            }}
          >
            New project
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => fileRef.current?.click()}
          >
            Import JSON
          </button>
          <button
            type="button"
            className="btn ghost"
            title="Load stress-200 enterprise pack into the Active project network"
            onClick={() => void loadStressIntoActive('200')}
          >
            Load stress-200
          </button>
          <button
            type="button"
            className="btn ghost"
            title="Load stress-120 enterprise pack into the Active project network"
            onClick={() => void loadStressIntoActive('120')}
          >
            Load stress-120
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json,.flowform.json"
            hidden
            onChange={(e) => {
              void onImportFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="studio-body projects-body">
        <div className="projects-list" role="list">
          {sorted.map((p) => {
            const active = p.id === activeProjectId
            const renaming = renameId === p.id
            return (
              <article
                key={p.id}
                className={active ? 'project-card active' : 'project-card'}
                role="listitem"
              >
                <div className="project-card-main">
                  {renaming ? (
                    <form
                      className="project-rename-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        commitRename()
                      }}
                    >
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        aria-label="Project name"
                      />
                      <button type="submit" className="btn primary sm">
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setRenameId(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <h2>{p.name}</h2>
                      <p className="project-meta-line">
                        {active && <span className="active-pill">Active</span>}
                        Updated {formatWhen(p.updatedAt)}
                        {projectMeta?.id === p.id &&
                          ` · ${p.id.slice(0, 12)}…`}
                      </p>
                    </>
                  )}
                </div>
                <div className="project-card-actions">
                  {!active && (
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => {
                        switchProject(p.id)
                        setStatus(`Switched to “${p.name}”.`)
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => startRename(p.id, p.name)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      const meta = duplicateProject(p.id)
                      setStatus(
                        meta
                          ? `Duplicated as “${meta.name}”.`
                          : 'Duplicate failed.',
                      )
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      if (active) exportActiveProject()
                      const ok = downloadProjectFile(p.id)
                      setStatus(ok ? `Exported “${p.name}”.` : 'Export failed.')
                    }}
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    disabled={projects.length <= 1}
                    title={
                      projects.length <= 1
                        ? 'Keep at least one project'
                        : 'Delete project'
                    }
                    onClick={() => {
                      if (
                        !confirm(
                          `Delete “${p.name}”? This cannot be undone.`,
                        )
                      ) {
                        return
                      }
                      deleteProject(p.id)
                      setStatus(`Deleted “${p.name}”.`)
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            )
          })}
        </div>
        {status && <p className="projects-status">{status}</p>}

        <div className="projects-decision-log-wrap">
          <DecisionLogPanel />
        </div>
      </div>
    </div>
  )
}
