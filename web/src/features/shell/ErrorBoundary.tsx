import { Component, type ReactNode } from 'react'
import { Button } from '../../components/ui'

/** Keeps a rendering bug in one page from blanking the whole application. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="alert alert--error" role="alert">
        This page could not be displayed. Your data was not changed.{' '}
        <Button small onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    )
  }
}
