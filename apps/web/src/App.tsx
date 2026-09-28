import { useMemo, useState } from 'react'
import './App.css'
import { LeftNav, type NavItem } from './components/LeftNav'
import { NetworkCanvas } from './components/NetworkCanvas'
import { PlaceholderRoom } from './components/PlaceholderRoom'
import { TopChrome } from './components/TopChrome'
import {
  HORIZON_OPTIONS,
  SCENARIOS,
} from './data/sampleNetwork'

function App() {
  const [room, setRoom] = useState<NavItem>('Network')
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const [horizon, setHorizon] =
    useState<(typeof HORIZON_OPTIONS)[number]>('FY27')

  const activeScenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId],
  )

  function handleScenarioChange(id: string) {
    setScenarioId(id)
  }

  return (
    <div className="shell">
      <TopChrome
        activeScenario={activeScenario}
        horizon={horizon}
        onHorizon={setHorizon}
      />
      <div className="app-body">
        <LeftNav active={room} onSelect={setRoom} />
        <main className="main-stage" aria-label={room}>
          {room === 'Network' ? (
            <NetworkCanvas
              activeScenarioId={scenarioId}
              onScenarioChange={handleScenarioChange}
            />
          ) : (
            <PlaceholderRoom room={room} />
          )}
        </main>
      </div>
    </div>
  )
}

export default App
