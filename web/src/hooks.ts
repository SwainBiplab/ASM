import { useRef } from 'react'

/**
 * Guards against the classic "stale response wins" race: a page re-fetches on every filter change
 * via `call(...).then(setData, setError)`, but nothing stops an earlier, slower request from
 * resolving after a later, faster one and overwriting the correct result with stale data (worse
 * under load, since an unfiltered query is typically slower than a narrowly filtered one -- the
 * exact case that made `reports.spec.ts` flaky: the initial unfiltered load occasionally resolved
 * after the just-selected category's filtered load, clobbering it back to the unfiltered totals).
 *
 * Usage: replace `call(cmd, input).then(setData, setError)` with
 * `guard(call(cmd, input)).then(setData, setError)` inside the same effect/callback.
 */
export function useLatestOnly() {
  const tokenRef = useRef(0)
  const stale = <T>(): Promise<T> => new Promise<T>(() => undefined) // a newer call is in flight; never settle this one
  return function guard<T>(promise: Promise<T>): Promise<T> {
    const token = ++tokenRef.current
    return promise.then(
      (value) => (tokenRef.current === token ? value : stale<T>()),
      (err) => (tokenRef.current === token ? Promise.reject<T>(err) : stale<T>())
    )
  }
}
