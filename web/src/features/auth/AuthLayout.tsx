import type { ReactNode } from 'react'
import { TagMark } from '../../components/ui'

export function AuthLayout({ heading, body, children }: { heading: string; body: string; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__aside">
        <TagMark />
        <div className="auth__aside-body">
          <h1>{heading}</h1>
          <p>{body}</p>
        </div>
        <p className="auth__aside-foot">Records are kept on your organization’s server. Sign-in is required on every device.</p>
      </aside>
      <main className="auth__main">{children}</main>
    </div>
  )
}
