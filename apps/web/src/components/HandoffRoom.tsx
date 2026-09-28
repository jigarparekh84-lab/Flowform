import { useFlowform } from '../state/FlowformContext'

export function HandoffRoom() {
  const { handoffPayload, brief, scenarios } = useFlowform()
  const payload = handoffPayload ?? (brief.sentToHandoffAt ? brief : null)
  const rec = scenarios.find((s) => s.id === payload?.recommendedScenarioId)

  return (
    <div className="studio-room handoff-room">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Handoff</p>
          <h1>Design exit ramp</h1>
          <p className="studio-sub">
            Clean brief of nodes, lanes, and assumptions toward Ritara APS.
            Design only — no planner screens here.
          </p>
        </div>
      </header>

      <div className="brief-layout">
        {!payload ? (
          <div className="library-card">
            <h2>Waiting for Brief</h2>
            <p className="studio-sub">
              Open Decision Brief, confirm the recommendation and assumptions,
              then click <strong>Send to Handoff</strong>.
            </p>
          </div>
        ) : (
          <>
            <div className="brief-banner">
              <div>
                <p className="map-kicker">Package ready</p>
                <h2>{rec?.name ?? 'Scenario'}</h2>
                <p>
                  Received{' '}
                  {payload.sentToHandoffAt
                    ? new Date(payload.sentToHandoffAt).toLocaleString()
                    : '—'}
                  . Export schema stub for Ritara intake — contract only.
                </p>
              </div>
            </div>
            <div className="library-card">
              <h2>Payload preview (JSON stub)</h2>
              <pre className="handoff-json">
                {JSON.stringify(
                  {
                    product: 'Flowform',
                    target: 'Ritara APS (intake contract)',
                    recommendedScenarioId: payload.recommendedScenarioId,
                    comparedIds: payload.comparedIds,
                    assumptions: payload.assumptions.filter((a) => a.checked),
                    notes: payload.notes,
                    sentAt: payload.sentToHandoffAt,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
