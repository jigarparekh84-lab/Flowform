import type { ReactNode } from 'react'

type Props = {
  kicker: string
  title: string
  /** One-liner room purpose shown under the title */
  tip: string
  actions?: ReactNode
  className?: string
}

/** Shared studio room header: kicker + title + tip (+ optional actions). */
export function RoomHeader({
  kicker,
  title,
  tip,
  actions,
  className = '',
}: Props) {
  return (
    <header
      className={`studio-header${className ? ` ${className}` : ''}`}
    >
      <div>
        <p className="map-kicker">{kicker}</p>
        <h1>{title}</h1>
        <p className="room-tip" role="note">
          <span className="room-tip-label" aria-hidden>
            Tip
          </span>
          {tip}
        </p>
      </div>
      {actions ? <div className="projects-header-actions">{actions}</div> : null}
    </header>
  )
}
