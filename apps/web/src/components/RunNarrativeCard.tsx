import { useMemo } from 'react'
import { buildRunNarrative } from '../data/narrative'
import type { OptimizeMeta } from '../data/sampleNetwork'

/** FF-115: plain-language summary of a Run (deterministic templates). */
export function RunNarrativeCard({
  meta,
  nameOf,
  title = 'What this Run says',
}: {
  meta: OptimizeMeta
  nameOf?: (id: string) => string
  title?: string
}) {
  const n = useMemo(() => buildRunNarrative(meta, nameOf), [meta, nameOf])
  return (
    <section className="library-card run-narrative" aria-label="Run summary" style={{ marginBottom: '1rem' }}>
      <h2>{title}</h2>
      <p><strong>{n.headline}</strong></p>
      <ul>
        {n.sentences.map((s) => (
          <li key={s.text} title={`From: ${s.sources.map((x) => x.field).join(', ')}`}>{s.text}</li>
        ))}
      </ul>
    </section>
  )
}
