import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { CompareResults } from './components/CompareResults'
import { DataRoom } from './components/DataRoom'
import { DecisionBrief } from './components/DecisionBrief'
import { GreenfieldStudio } from './components/GreenfieldStudio'
import { HubSpokeStudio } from './components/HubSpokeStudio'
import { TerritoryStudio } from './components/TerritoryStudio'
import { RoadmapStudio } from './components/RoadmapStudio'
import { HandoffRoom } from './components/HandoffRoom'
import { LeftNav, type NavItem } from './components/LeftNav'
import { MergeStudio } from './components/MergeStudio'
import { NetworkCanvas } from './components/NetworkCanvas'
import { ProjectsRoom } from './components/ProjectsRoom'
import { ScenariosLibrary } from './components/ScenariosLibrary'
import { TopChrome } from './components/TopChrome'
import { KeyboardHelp } from './components/ui/KeyboardHelp'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'
import { START_WIZARD_EVENT } from './data/onboarding'
import { useFlowform } from './state/FlowformContext'
import { useTheme } from './state/theme'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

function App() {
  const [room, setRoom] = useState<NavItem>('Network')
  const [helpOpen, setHelpOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const { activeScenario, horizon, setHorizon, clearSelection } = useFlowform()
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    const open = () => setWizardOpen(true)
    window.addEventListener(START_WIZARD_EVENT, open)
    return () => window.removeEventListener(START_WIZARD_EVENT, open)
  }, [])

  const closeHelp = useCallback(() => setHelpOpen(false), [])
  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return

      if (e.key === 'Escape') {
        if (helpOpen) {
          setHelpOpen(false)
          return
        }
        clearSelection()
        return
      }

      // ? opens help (Shift+/ on US keyboards also yields '?')
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setHelpOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearSelection, helpOpen])

  return (
    <div className="shell">
      <TopChrome
        activeScenario={activeScenario}
        horizon={horizon}
        onHorizon={setHorizon}
        onCompare={() => setRoom('Compare')}
        onOpenProjects={() => setRoom('Projects')}
        onHelp={toggleHelp}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="app-body">
        <LeftNav active={room} onSelect={setRoom} />
        <main className="main-stage" aria-label={room}>
          {room === 'Projects' && <ProjectsRoom onStartWizard={() => setWizardOpen(true)} />}
          {room === 'Network' && <NetworkCanvas />}
          {room === 'Greenfield' && <GreenfieldStudio />}
          {room === 'Hubs' && <HubSpokeStudio />}
          {room === 'Territory' && <TerritoryStudio />}
          {room === 'Roadmap' && <RoadmapStudio />}
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
      <KeyboardHelp open={helpOpen} onClose={closeHelp} />
      <OnboardingWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onDone={() => setRoom('Compare')} />
    </div>
  )
}

export default App
