import { useMemo, useRef, useState } from 'react'
import type { UploadedNetwork } from '../data/csvParsers'
import {
  detectMergeConflicts,
  mergeNetworks,
  parseAcquiredNetworkJson,
  previewMerge,
  sampleAcquiredNetwork,
  type MergeConflict,
} from '../data/networkMerge'
import { useFlowform } from '../state/FlowformContext'

export function MergeStudio() {
  const { network, applyMergedNetwork } = useFlowform()
  const fileRef = useRef<HTMLInputElement>(null)
  const [acquired, setAcquired] = useState<UploadedNetwork | null>(null)
  const [sourceLabel, setSourceLabel] = useState<string | null>(null)
  const [resolutions, setResolutions] = useState<
    Record<string, MergeConflict['resolution']>
  >({})
  const [status, setStatus] = useState<string | null>(null)

  const conflicts = useMemo(() => {
    if (!acquired) return []
    return detectMergeConflicts(network, acquired).map((c) => ({
      ...c,
      resolution:
        resolutions[`${c.kind}:${c.id}`] ?? c.resolution,
    }))
  }, [network, acquired, resolutions])

  const preview = useMemo(() => {
    if (!acquired) return null
    return previewMerge(network, acquired, resolutions)
  }, [network, acquired, resolutions])

  function loadSample() {
    const net = sampleAcquiredNetwork()
    setAcquired(net)
    setSourceLabel('Sample acquired network')
    setResolutions({})
    setStatus(
      `Loaded sample acquired · ${net.nodes.length} nodes · ${net.lanes.length} lanes`,
    )
  }

  async function onFile(file: File | null) {
    if (!file) return
    try {
      const text = await file.text()
      const raw = JSON.parse(text) as unknown
      const net = parseAcquiredNetworkJson(raw)
      if (!net) {
        setStatus('Import failed — expected network or Flowform project JSON.')
        return
      }
      setAcquired(net)
      setSourceLabel(file.name)
      setResolutions({})
      setStatus(
        `Imported ${file.name} · ${net.nodes.length} nodes · ${net.lanes.length} lanes`,
      )
    } catch {
      setStatus('Import failed — invalid JSON.')
    }
  }

  function setResolution(
    kind: MergeConflict['kind'],
    id: string,
    resolution: MergeConflict['resolution'],
  ) {
    setResolutions((prev) => ({
      ...prev,
      [`${kind}:${id}`]: resolution,
    }))
  }

  function handleMerge() {
    if (!acquired) {
      setStatus('Load an acquired network first.')
      return
    }
    const result = mergeNetworks(network, acquired, resolutions)
    applyMergedNetwork(result.network, result.draftScenario)
    setStatus(
      `${result.summary} Draft scenario “${result.draftScenario.name}” is now Active.`,
    )
  }

  return (
    <div className="studio-room merge-room">
      <header className="studio-header">
        <div>
          <p className="map-kicker">M&amp;A</p>
          <h1>Merge studio</h1>
          <p className="studio-sub">
            Import a second (acquired) network JSON or load the sample. Review
            duplicate-id conflicts, merge nodes/lanes, and produce a merged
            baseline draft scenario.
          </p>
        </div>
        <div className="projects-header-actions">
          <button type="button" className="btn primary" onClick={loadSample}>
            Load sample acquired
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => fileRef.current?.click()}
          >
            Import network JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json,.flowform.json,.share.json"
            hidden
            onChange={(e) => {
              void onFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="studio-body merge-body">
        <aside className="wizard-panel" aria-label="Merge sources">
          <h2>Sources</h2>
          <div className="data-scores merge-scores">
            <div className="score-card">
              <span className="score-label">Primary (active)</span>
              <strong className="score-value">
                {network.nodes.length} nodes · {network.lanes.length} lanes
              </strong>
              <span className="score-sub">
                {network.source === 'sample' ? 'Sample' : 'Upload'} network
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">Acquired</span>
              <strong className="score-value">
                {acquired
                  ? `${acquired.nodes.length} nodes · ${acquired.lanes.length} lanes`
                  : '—'}
              </strong>
              <span className="score-sub">{sourceLabel ?? 'Not loaded'}</span>
            </div>
            {preview && (
              <div className="score-card">
                <span className="score-label">Merged preview</span>
                <strong className="score-value">
                  {preview.mergedNodeCount} nodes · {preview.mergedLaneCount}{' '}
                  lanes
                </strong>
                <span className="score-sub">
                  {preview.conflicts.length} conflict
                  {preview.conflicts.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>

          <div className="promote-block">
            <button
              type="button"
              className="btn primary wizard-run"
              disabled={!acquired}
              onClick={handleMerge}
            >
              Apply merge + draft scenario
            </button>
          </div>
          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="studio-main merge-main">
          <h2>Conflicts</h2>
          {!acquired && (
            <p className="hint">
              Load the sample acquired network or import a JSON export to see
              duplicate id conflicts.
            </p>
          )}
          {acquired && conflicts.length === 0 && (
            <p className="status-line">No duplicate ids — clean merge.</p>
          )}
          {conflicts.length > 0 && (
            <div className="table-scroll merge-conflicts">
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Id</th>
                    <th>Primary</th>
                    <th>Acquired</th>
                    <th>Resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {conflicts.map((c) => (
                    <tr key={`${c.kind}:${c.id}`}>
                      <td>{c.kind}</td>
                      <td className="mono">{c.id}</td>
                      <td>{c.primaryLabel}</td>
                      <td>{c.acquiredLabel}</td>
                      <td>
                        <select
                          value={c.resolution}
                          onChange={(e) =>
                            setResolution(
                              c.kind,
                              c.id,
                              e.target.value as MergeConflict['resolution'],
                            )
                          }
                        >
                          <option value="rename-acquired">
                            Keep both (rename acquired)
                          </option>
                          <option value="keep-primary">Keep primary only</option>
                          <option value="keep-acquired">
                            Replace with acquired
                          </option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
