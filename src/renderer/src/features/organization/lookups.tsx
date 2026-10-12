import { useCallback, useEffect, useId, useState } from 'react'
import type { DepartmentView, EmployeeListItem, LocationView, TeamView } from '@shared/api'
import { call } from '../../api'

export interface OrgLookups {
  departments: DepartmentView[]
  teams: TeamView[]
  locations: LocationView[]
  reload: () => void
}

/** Active departments, teams and locations for pickers. */
export function useOrgLookups(): OrgLookups {
  const [state, setState] = useState<Omit<OrgLookups, 'reload'>>({ departments: [], teams: [], locations: [] })
  const reload = useCallback(() => {
    Promise.all([call('departments.list', {}), call('teams.list', {}), call('locations.list', {})])
      .then(([departments, teams, locations]) => setState({ departments, teams, locations }))
      .catch(() => undefined)
  }, [])
  useEffect(reload, [reload])
  return { ...state, reload }
}

export const optionList = <T extends { id: string }>(items: T[], label: (t: T) => string) => items.map((i) => ({ value: i.id, label: label(i) }))

/**
 * Searches current employees as the user types (server-side), so large employee lists never
 * load into one dropdown. Stores the selected employee's id.
 */
export function EmployeePicker({
  label,
  value,
  initialLabel,
  onChange,
  excludeId,
  error
}: {
  label: string
  value: string | null
  initialLabel?: string | null
  onChange: (id: string | null) => void
  excludeId?: string
  error?: string | undefined
}) {
  const id = useId()
  const [text, setText] = useState(initialLabel ?? '')
  const [results, setResults] = useState<EmployeeListItem[]>([])
  const format = (e: EmployeeListItem) => `${e.employeeCode} — ${e.fullName}`

  useEffect(() => {
    const q = text.split(' — ')[0]?.trim() ?? ''
    const handle = window.setTimeout(() => {
      call('employees.search', { query: q || undefined, pageSize: 20 })
        .then((page) => setResults(page.items.filter((e) => e.id !== excludeId)))
        .catch(() => setResults([]))
    }, 200)
    return () => window.clearTimeout(handle)
  }, [text, excludeId])

  const onText = (next: string) => {
    setText(next)
    const match = results.find((e) => format(e) === next)
    if (match) onChange(match.id)
    else if (next.trim() === '') onChange(null)
  }

  const unresolved = text.trim() !== '' && !value
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" list={`${id}-list`} value={text} onChange={(e) => onText(e.target.value)} placeholder="Type an ID or name" aria-invalid={error || unresolved ? true : undefined} />
      <datalist id={`${id}-list`}>
        {results.map((e) => (
          <option key={e.id} value={format(e)} />
        ))}
      </datalist>
      {error ? <span className="field__error">{error}</span> : unresolved ? <span className="field__error">Choose an employee from the list</span> : <span className="field__hint">Leave empty for none</span>}
    </div>
  )
}
