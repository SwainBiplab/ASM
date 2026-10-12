import { Button, Panel, TagMark } from '../../components/ui'

/** First-time setup is an operator task (bootstrap CLI), never a public web page (W1). */
export function SetupRequiredScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="recovery">
      <TagMark />
      <h1>This system has not been set up yet</h1>
      <p className="muted">
        An administrator must create the organization and the first Super Admin account on the server before anyone can sign in.
      </p>
      <Panel title="For the administrator">
        <p className="muted">
          Run <span className="ident">npm run server:bootstrap</span> on the server (see the deployment notes), then reload this page.
        </p>
        <div className="form-actions">
          <Button variant="primary" onClick={onRetry}>
            Check again
          </Button>
        </div>
      </Panel>
    </div>
  )
}
