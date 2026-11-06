import { Component, type ErrorInfo, type ReactNode } from 'react'
import { PageHeader } from './Conversation'
import { StateNotice } from './states'

/**
 * Contains a render failure to the view: the sidebar, the palette and the other routes stay
 * usable. No `key`: a key on the route would remount views that share a component across routes
 * and lose their drafts, so a route change clears the failure here instead.
 */
type Props = { label: string; children: ReactNode }
type State = { error: Error | null }

export class ViewBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.label !== this.props.label && this.state.error !== null) this.setState({ error: null })
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink: nothing here may reach a store, and the message is not shown raw.
    console.error(`[view:${this.props.label}]`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="page">
        <PageHeader title="This view could not be shown" />
        <StateNotice
          kind="error"
          title="Something went wrong here"
          body={`${this.props.label} hit an error while drawing. The rest of the workbench still works: use the sidebar to go elsewhere, or try this view again.`}
          action={{ label: 'Try again', onClick: () => this.setState({ error: null }) }}
        />
      </div>
    )
  }
}
