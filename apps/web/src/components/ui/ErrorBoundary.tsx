import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../../data/reporting'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * Last line of defence for the studio. A render error in one room must not
 * leave the user staring at a blank page with no way back. Projects live in
 * localStorage, so a reload is a safe recovery path.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, {
      source: 'error-boundary',
      componentStack: info.componentStack ?? undefined,
    })
  }

  private reload = () => {
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="error-boundary-shell" role="alert">
        <div className="error-boundary-card">
          <p className="error-boundary-kicker">Flowform</p>
          <h1>Something went wrong in this view</h1>
          <p className="error-boundary-body">
            Your projects are stored in this browser and have not been deleted.
            Reload the studio to continue.
          </p>
          <button
            type="button"
            className="error-boundary-action"
            onClick={this.reload}
          >
            Reload studio
          </button>
          <details className="error-boundary-details">
            <summary>Technical details</summary>
            <pre>{error.message}</pre>
          </details>
        </div>
      </div>
    )
  }
}
