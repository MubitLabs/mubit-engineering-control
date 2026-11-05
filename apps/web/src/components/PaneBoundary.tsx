import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Btn } from './base'

/**
 * Contains a render failure to the pane: the rail, the palette and the other routes stay usable.
 * Mount it with `key={route}` so navigating elsewhere clears the failure; "Try again" re-renders
 * the same view.
 */
type Props = { label: string; children: ReactNode }
type State = { error: Error | null }

export class PaneBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink: nothing here may reach a store, and the message is not shown raw.
    console.error(`[pane:${this.props.label}]`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <section className="pane is-active" role="alert" aria-labelledby="pane-failed-title">
        <header className="pane-head">
          <h1 className="pane-title" id="pane-failed-title">
            This view could not be shown
          </h1>
        </header>
        <div className="empty">
          <p>
            {this.props.label} hit an error while drawing. The rest of the workbench still works: use the
            sidebar to go elsewhere, or try this view again.
          </p>
          <p>
            <Btn onClick={() => this.setState({ error: null })}>Try again</Btn>
          </p>
        </div>
      </section>
    )
  }
}
