import { useState } from 'react'
import './App.css'
import { CompareResults } from './components/CompareResults'
import { GreenfieldStudio } from './components/GreenfieldStudio'
import { LeftNav, type NavItem } from './components/LeftNav'
import { NetworkCanvas } from './components/NetworkCanvas'
import { PlaceholderRoom } from './components/PlaceholderRoom'
import { ScenariosLibrary } from './components/ScenariosLibrary'
import { TopChrome } from './components/TopChrome'
import { useFlowform } from './state/FlowformContext'
import { useTheme } from './state/theme'

function App() {
  const [room, setRoom] = useState<NavItem>('Network')
  const { activeScenario, horizon, setHorizon } = useFlowform()
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="shell">
      <TopChrome
        activeScenario={activeScenario}
        horizon={horizon}
        onHorizon={setHorizon}
        onCompare={() => setRoom('Compare')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="app-body">
        <LeftNav active={room} onSelect={setRoom} />
        <main className="main-stage" aria-label={room}>
          {room === 'Network' && <NetworkCanvas />}
          {room === 'Greenfield' && <GreenfieldStudio />}
          {room === 'Scenarios' && <ScenariosLibrary />}
          {room === 'Compare' && <CompareResults />}
          {room !== 'Network' &&
            room !== 'Greenfield' &&
            room !== 'Scenarios' &&
            room !== 'Compare' && <PlaceholderRoom room={room} />}
        </main>
      </div>
    </div>
  )
}

export default App
