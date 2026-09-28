export const NAV_ITEMS = [
  'Projects',
  'Network',
  'Greenfield',
  'Scenarios',
  'Compare',
  'Brief',
  'Data',
  'Merge',
  'Handoff',
] as const

export type NavItem = (typeof NAV_ITEMS)[number]

type Props = {
  active: NavItem
  onSelect: (item: NavItem) => void
}

const ICONS: Record<NavItem, string> = {
  Projects: '◫',
  Network: '◎',
  Greenfield: '◇',
  Scenarios: '⎇',
  Compare: '⇄',
  Brief: '☰',
  Data: '▤',
  Merge: '⧉',
  Handoff: '⇢',
}

export function LeftNav({ active, onSelect }: Props) {
  return (
    <nav className="left-nav" aria-label="Primary">
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item}>
            <button
              type="button"
              className={active === item ? 'nav-item active' : 'nav-item'}
              onClick={() => onSelect(item)}
              aria-current={active === item ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden>
                {ICONS[item]}
              </span>
              <span>{item}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
