import type { StartupState } from '@shared/api'
import { Button, Panel, TagMark } from '../../components/ui'

/** Shown instead of silently creating a new database when startup checks fail (TAS §15). */
export function RecoveryScreen({ startup, onRetry }: { startup: StartupState; onRetry: () => void }) {
  return (
    <div className="recovery">
      <TagMark />
      <h1>The database could not be opened</h1>
      <p className="muted">
        The application stopped before changing anything, so existing records are untouched. A new, empty database was not
        created.
      </p>
      <Panel title="What happened">
        <dl className="dl">
          <dt>Problem</dt>
          <dd>{startup.error?.message ?? 'Unknown error'}</dd>
          <dt>Reference</dt>
          <dd className="ident">{startup.error?.correlationId ?? '—'}</dd>
          {startup.dataDirectory ? (
            <>
              <dt>Data folder</dt>
              <dd>{startup.dataDirectory}</dd>
            </>
          ) : null}
          <dt>Version</dt>
          <dd>{startup.appVersion}</dd>
        </dl>
      </Panel>
      <Panel title="Next steps">
        <ol className="muted">
          <li>Close the application and make sure no other copy of it is running, then try again.</li>
          <li>If the problem continues, give the reference above and the files in the data folder's logs subfolder to your IT administrator.</li>
          <li>An administrator can restore the most recent backup by following docs/RECOVERY.md.</li>
        </ol>
        <div className="form-actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Panel>
    </div>
  )
}
