import type { NavItem } from './LeftNav'

type Props = {
  room: NavItem
}

const COPY: Partial<Record<NavItem, { title: string; body: string }>> = {
  Projects: {
    title: 'Projects',
    body: 'Workspace home for network design projects. Open or create a footprint study — stub for MVP.',
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
