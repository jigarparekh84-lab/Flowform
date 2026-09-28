import type { ReactNode } from 'react'

type Props = {
  title: string
  body: string
  action?: ReactNode
  /** Compact for side panels / inline cards */
  compact?: boolean
  className?: string
}

/** Consistent empty state for rooms and panels when there is no data or selection. */
export function EmptyState({
  title,
  body,
  action,
  compact = false,
  className = '',
}: Props) {
  return (
    <div
      className={`empty-state${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}
      role="status"
    >
      <div className="empty-state-icon" aria-hidden>
        ◇
      </div>
      <p className="empty-state-title">{title}</p>
      <p className="empty-state-body">{body}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  )
}
