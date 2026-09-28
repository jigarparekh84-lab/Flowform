import type { NavItem } from './LeftNav'

type Props = {
  room: NavItem
}

const COPY: Partial<Record<NavItem, { title: string; body: string }>> = {
  Projects: {
    title: 'Projects',
    body: 'Workspace home for network design projects. Open or create a footprint study — stub for MVP.',
  },
  Greenfield: {
    title: 'Greenfield',
    body: 'Blank-slate footprint design: candidate sites, demand anchors, and service radii on an empty canvas. Same vocabulary as Network — mode stub.',
  },
  Scenarios: {
    title: 'Scenarios',
    body: 'Named what-ifs branched from the baseline. Manage branches here; switch them from the Network canvas footer.',
  },
  Compare: {
    title: 'Compare',
    body: 'Side-by-side and overlay deltas for cost, service, CapEx, CO₂, and risk across scenarios. Report surface stub.',
  },
  Brief: {
    title: 'Brief',
    body: 'Narrative + assumptions package for stakeholders. Capture the design story before handoff.',
  },
  Data: {
    title: 'Data',
    body: 'Imports, reference tables, and validation for nodes, lanes, demand, and cost drivers.',
  },
  Handoff: {
    title: 'Handoff',
    body: 'Export a clean brief of nodes, lanes, and assumptions toward Ritara APS. Design exit ramp — no planner screens here.',
  },
}

export function PlaceholderRoom({ room }: Props) {
  const meta = COPY[room] ?? { title: room, body: 'Placeholder room.' }
  return (
    <div className="placeholder-room">
      <p className="map-kicker">Room stub</p>
      <h1>{meta.title}</h1>
      <p>{meta.body}</p>
    </div>
  )
}
