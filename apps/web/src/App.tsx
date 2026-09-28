import { useState } from 'react'
import './App.css'
import { CompareResults } from './components/CompareResults'
import { DataRoom } from './components/DataRoom'
import { DecisionBrief } from './components/DecisionBrief'
import { GreenfieldStudio } from './components/GreenfieldStudio'
import { HubSpokeStudio } from './components/HubSpokeStudio'
import { TerritoryStudio } from './components/TerritoryStudio'
import { HandoffRoom } from './components/HandoffRoom'
import { LeftNav, type NavItem } from './components/LeftNav'
import { MergeStudio } from './components/MergeStudio'
import { NetworkCanvas } from './components/NetworkCanvas'
import { ProjectsRoom } from './components/ProjectsRoom'
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
        onOpenProjects={() => setRoom('Projects')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="app-body">
        <LeftNav active={room} onSelect={setRoom} />
        <main className="main-stage" aria-label={room}>
          {room === 'Projects' && <ProjectsRoom />}
          {room === 'Network' && <NetworkCanvas />}
          {room === 'Greenfield' && <GreenfieldStudio />}
          {room === 'Hubs' && <HubSpokeStudio />}
          {room === 'Territory' && <TerritoryStudio />}
          {room === 'Scenarios' && <ScenariosLibrary />}
          {room === 'Compare' && <CompareResults />}
          {room === 'Brief' && (
            <DecisionBrief onHandoff={() => setRoom('Handoff')} />
          )}
          {room === 'Data' && <DataRoom />}
          {room === 'Merge' && <MergeStudio />}
          {room === 'Handoff' && <HandoffRoom />}
        </main>
      </div>
    </div>
  )
}

export default App
