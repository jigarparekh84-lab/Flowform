import { useEffect, useState } from 'react'
import { DEFAULT_API_BASE } from '../data/apiBase'
import { cancelActiveRun, getActiveJob, subscribeActiveJob, type ActiveJob } from '../data/jobsApi'

const KIND: Record<ActiveJob['kind'], string> = { optimize: 'Run', 'multi-period': 'Roadmap', stochastic: 'Robust' }

/** Progress + Cancel for any in-flight solve (Run / Roadmap / Robust). */
export function ActiveJobChip() {
  const [job, setJob] = useState<ActiveJob | null>(getActiveJob())
  const [cancelling, setCancelling] = useState(false)
  useEffect(() => subscribeActiveJob((j) => { setJob(j); if (!j) setCancelling(false) }), [])
  if (!job) return null
  const pct = Math.round((job.progress ?? 0) * 100)
  return (
    <span className="run-meta" aria-label="Solve in progress" data-testid="active-job">
      <span className="run-chip" title={job.runId ? `Server run ${job.runId}` : 'Direct (sync) solve'}>
        {KIND[job.kind]} · {job.runId ? `${job.status} ${pct}%` : 'direct'} · {job.message}
      </span>
      <button
        type="button"
        className="btn ghost btn-tiny"
        disabled={cancelling}
        onClick={() => { setCancelling(true); void cancelActiveRun(DEFAULT_API_BASE) }}
      >
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </span>
  )
}
