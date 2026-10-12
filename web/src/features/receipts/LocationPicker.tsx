import { useEffect, useState } from 'react'
import type { LocationView } from '@shared/api'
import { call } from '../../api'
import { SelectField } from '../../components/ui'

export function LocationPicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [locations, setLocations] = useState<LocationView[]>([])
  useEffect(() => {
    call('locations.list', { includeInactive: false }).then(setLocations, () => setLocations([]))
  }, [])
  return <SelectField label="Received into location" value={value ?? ''} placeholder="Choose" onChange={(v) => onChange(v || null)} options={locations.map((l) => ({ value: l.id, label: l.path }))} />
}
