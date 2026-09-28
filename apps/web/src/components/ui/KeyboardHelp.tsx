import { useEffect, useId } from 'react'

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Esc', action: 'Clear map / table selection' },
  { keys: '?', action: 'Show or hide this help' },
  { keys: 'Shift + click', action: 'Multi-select nodes or lanes' },
  { keys: 'Click map background', action: 'Clear selection' },
]

type Props = {
  open: boolean
  onClose: () => void
}

export function KeyboardHelp({ open, onClose }: Props) {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="help-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-dialog-head">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <button
            type="button"
            className="btn ghost btn-tiny"
            onClick={onClose}
            aria-label="Close help"
          >
            Esc
          </button>
        </div>
        <ul className="help-shortcut-list">
          {SHORTCUTS.map((row) => (
            <li key={row.keys}>
              <kbd>{row.keys}</kbd>
              <span>{row.action}</span>
            </li>
          ))}
        </ul>
        <p className="help-footnote muted tiny">
          Shortcuts are ignored while typing in inputs or text areas.
        </p>
      </div>
    </div>
  )
}
