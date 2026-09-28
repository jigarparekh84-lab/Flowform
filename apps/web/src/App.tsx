import { useState } from 'react'
import './App.css'
import { GreenfieldStudio } from './components/GreenfieldStudio'
import { LeftNav, type NavItem } from './components/LeftNav'
import { NetworkCanvas } from './components/NetworkCanvas'
import { PlaceholderRoom } from './components/PlaceholderRoom'
import { ScenariosLibrary } from './components/ScenariosLibrary'
import { TopChrome } from './components/TopChrome'
import { useFlowform } from './state/FlowformContext'

function App() {
  const [room, setRoom] = useState<NavItem>('Network')
  const { activeScenario, horizon, setHorizon } = useFlowform()

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
          {room === 'Network' && <NetworkCanvas />}
          {room === 'Greenfield' && <GreenfieldStudio />}
          {room === 'Scenarios' && <ScenariosLibrary />}
          {room !== 'Network' &&
            room !== 'Greenfield' &&
            room !== 'Scenarios' && <PlaceholderRoom room={room} />}
        </main>
      </div>
    </div>
  )
}

export default App
