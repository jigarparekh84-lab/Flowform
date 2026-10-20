import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildStarterModel,
  QUESTION_LABELS,
  type OnboardingAnswers,
  type OnboardingQuestion,
} from '../../data/onboarding'
import type { Scenario } from '../../data/sampleNetwork'
import { useFlowform } from '../../state/FlowformContext'
import { RunNarrativeCard } from '../RunNarrativeCard'

const EXAMPLE: OnboardingAnswers = {
  projectName: 'My first network',
  products: 'Ambient goods, 8\nChilled',
  customers: '10001, 4000\n60601, 3500\n90012, 5000\n75201, 3000\n30303, 2500\n98101, 1500\n33101\n80202, 1200',
  sites: 'Columbus, OH, existing, 12000\nReno, NV, existing\nAtlanta, GA, candidate, 9000',
  question: 'keep-or-close',
}

const STEPS = ['What you sell', 'Where customers are', 'Where your sites are', 'Your question', 'Review'] as const

/** FF-110: four questions → starter model → guardrails → first Run result. */
export function OnboardingWizard({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { createProject, importEnterprisePack, runOptimize, network, optimizeStatus } = useFlowform()
  const [step, setStep] = useState(0)
  const [a, setA] = useState<OnboardingAnswers>({ products: '', customers: '', sites: '', question: 'keep-or-close' })
  const [phase, setPhase] = useState<'edit' | 'building' | 'running' | 'done' | 'error'>('edit')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Scenario | null>(null)
  const expectNodes = useRef<number | null>(null)

  const model = useMemo(() => buildStarterModel(a), [a])
  const customerCount = model.pack.sites.filter((s) => s.kind === 'demand').length
  const siteCount = model.pack.sites.filter((s) => s.kind === 'dc' || s.kind === 'candidate').length

  // Run once the imported model is in state (runOptimize closes over the new network).
  useEffect(() => {
    if (phase !== 'building' || expectNodes.current == null) return
    if (network.nodes.length !== expectNodes.current) return
    expectNodes.current = null
    setPhase('running')
    void runOptimize().then((sc) => {
      setResult(sc)
      setPhase(sc ? 'done' : 'error')
      if (!sc) setError('The first Run did not finish — see the status bar for the reason.')
    })
  }, [phase, network, runOptimize])

  if (!open) return null

  const set = (k: keyof OnboardingAnswers) => (e: { target: { value: string } }) =>
    setA((p) => ({ ...p, [k]: e.target.value }))
  const canNext =
    (step === 0) || (step === 1 && customerCount > 0) || (step === 2 && siteCount > 0) || step === 3

  function build() {
    setError(null)
    createProject(a.projectName?.trim() || model.pack.name)
    const card = importEnterprisePack(model.pack)
    if (!card || card.errorCount > 0) {
      setPhase('error')
      setError(`The starter model has ${card?.errorCount ?? '?'} data error(s); go back and check your lines.`)
      return
    }
    expectNodes.current = model.pack.sites.length
    setPhase('building')
  }

  const om = result?.optimizeMeta
  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-labelledby="ff-wizard-title" onClick={onClose}>
      <div className="help-dialog onboarding-wizard" style={{ width: 'min(720px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="help-dialog-head">
          <h2 id="ff-wizard-title">
            Build your network in 4 questions <span className="muted tiny">· step {Math.min(step + 1, 5)} of 5 — {STEPS[step]}</span>
          </h2>
          <button type="button" className="btn ghost btn-tiny" onClick={onClose} aria-label="Close wizard">Esc</button>
        </div>

        {phase === 'edit' && (
          <div className="wizard-body" style={{ display: 'grid', gap: 10 }}>
            {step === 0 && (
              <>
                <label>Project name <input value={a.projectName ?? ''} onChange={set('projectName')} placeholder="My first network" /></label>
                <label>
                  What do you sell? One product family per line, optionally “, kg per unit”.
                  <textarea rows={4} value={a.products} onChange={set('products')} placeholder={'Ambient goods, 8\nChilled'} />
                </label>
                <button type="button" className="btn ghost btn-tiny" onClick={() => setA(EXAMPLE)}>Fill with an example</button>
              </>
            )}
            {step === 1 && (
              <label>
                Where are your customers? One per line: ZIP, “City, ST” or “lat, lng”, then optional yearly volume.
                <textarea rows={8} value={a.customers} onChange={set('customers')} placeholder={'10001, 4000\n60601, 3500\nDallas, TX'} />
                <span className="muted tiny">{customerCount} recognised</span>
              </label>
            )}
            {step === 2 && (
              <label>
                Where are your sites? One per line: location, then optional “existing”, “candidate” or “plant”, and capacity.
                <textarea rows={6} value={a.sites} onChange={set('sites')} placeholder={'Columbus, OH, existing, 12000\nReno, NV\nAtlanta, GA, candidate'} />
                <span className="muted tiny">{siteCount} recognised</span>
              </label>
            )}
            {step === 3 && (
              <fieldset style={{ display: 'grid', gap: 6 }}>
                <legend>Which question should Flowform answer?</legend>
                {(Object.keys(QUESTION_LABELS) as OnboardingQuestion[]).map((q) => (
                  <label key={q}>
                    <input type="radio" name="ff-q" checked={a.question === q} onChange={() => setA((p) => ({ ...p, question: q }))} /> {QUESTION_LABELS[q]}
                  </label>
                ))}
              </fieldset>
            )}
            {step === 4 && (
              <div>
                <p>
                  {customerCount} customers · {siteCount} sites · {model.pack.demand.reduce((t, d) => t + d.volume, 0).toLocaleString()} units of demand ·
                  question: <strong>{QUESTION_LABELS[a.question]}</strong>
                </p>
                <p className="muted tiny">We filled in these defaults (marked “assumed” — refine them later in Data):</p>
                <ul className="tiny">{model.assumptions.map((x) => <li key={x}>assumed — {x}</li>)}</ul>
                {model.skipped.length > 0 && (
                  <>
                    <p className="muted tiny">Skipped lines:</p>
                    <ul className="tiny">{model.skipped.map((x) => <li key={x}>{x}</li>)}</ul>
                  </>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {step > 0 && <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}
              {step < 4 && <button type="button" className="btn" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button>}
              {step === 4 && <button type="button" className="btn" disabled={!customerCount || !siteCount} onClick={build}>Build model &amp; Run</button>}
            </div>
          </div>
        )}

        {(phase === 'building' || phase === 'running') && (
          <p role="status">
            {phase === 'building' ? 'Building your model…' : optimizeStatus.phase === 'running' ? optimizeStatus.message : 'Solving…'}
          </p>
        )}

        {phase === 'error' && (
          <div role="alert">
            <p>{error}</p>
            {optimizeStatus.phase === 'error' && <p className="muted tiny">{optimizeStatus.message}</p>}
            <button type="button" className="btn ghost" onClick={() => { setPhase('edit'); setStep(1) }}>Back to my answers</button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="wizard-result" data-testid="wizard-result">
            <h3>Your first result</h3>
            {om && (
              <p>
                {om.status ?? 'Solved'} · total cost {om.objectiveBreakdown ? `$${om.objectiveBreakdown.totalM.toFixed(2)}M` : '—'} ·
                service {om.servicePct.toFixed(1)}% · opens {om.openedIds.length} · closes {om.closedIds.length}
              </p>
            )}
            {om && (
              <RunNarrativeCard
                meta={om}
                title="In plain words"
                nameOf={(id) => network.nodes.find((n) => n.id === id)?.name ?? id}
              />
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={onClose}>Stay here</button>
              <button type="button" className="btn" onClick={() => { onClose(); onDone() }}>See the full comparison</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
