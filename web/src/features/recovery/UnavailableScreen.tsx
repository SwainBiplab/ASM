import { Button, Panel, TagMark } from '../../components/ui'

/** Shown when the API cannot be reached or reports an error during start-up. Nothing is changed. */
export function UnavailableScreen({ message, reference, onRetry }: { message: string; reference: string | null; onRetry: () => void }) {
  return (
    <div className="recovery">
      <TagMark />
      <h1>The service is not available</h1>
      <p className="muted">The application could not reach the asset management server. No records were changed.</p>
      <Panel title="What happened">
        <dl className="dl">
          <dt>Problem</dt>
          <dd>{message}</dd>
          {reference ? (
            <>
              <dt>Reference</dt>
              <dd className="ident">{reference}</dd>
            </>
          ) : null}
        </dl>
        <div className="form-actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Panel>
    </div>
  )
}
