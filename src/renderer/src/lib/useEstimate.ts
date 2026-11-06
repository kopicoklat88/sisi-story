import { useEffect, useState } from 'react'
import type { AspectRatio, CreditEstimate, VisualProvider } from '@shared/types'

/** The provider's price for one request. undefined while loading, null when it cannot be estimated (no key, offline, or Gemini per-use billing). */
export function useEstimate(
  provider: VisualProvider,
  kind: 'image' | 'video',
  modelId: string,
  aspect: AspectRatio,
  seconds?: number,
  resolution?: string | null
): CreditEstimate | null | undefined {
  const [value, setValue] = useState<CreditEstimate | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setValue(undefined)
    window.api.generate
      .estimate(provider, kind, modelId, aspect, seconds, resolution)
      .then((v) => alive && setValue(v))
      .catch(() => alive && setValue(null))
    return () => {
      alive = false
    }
  }, [provider, kind, modelId, aspect, seconds, resolution])
  return value
}

/**
 * Estimates for a whole list of models, filled in as they arrive (three requests at a time).
 * Results are cached in the main process, so reopening a picker is instant.
 */
export function useEstimates(
  provider: VisualProvider,
  kind: 'image' | 'video',
  ids: string[],
  aspect: AspectRatio,
  seconds: number | undefined,
  enabled: boolean
): Record<string, CreditEstimate | null> {
  const context = `${provider}|${kind}|${aspect}|${seconds ?? ''}|${ids.join(',')}`
  const [state, setState] = useState<{ context: string; map: Record<string, CreditEstimate | null> }>({ context, map: {} })

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const queue = [...ids]
    const worker = async (): Promise<void> => {
      while (alive && queue.length) {
        const id = queue.shift()!
        const value = await window.api.generate.estimate(provider, kind, id, aspect, seconds).catch(() => null)
        if (!alive) return
        setState((s) => ({ context, map: { ...(s.context === context ? s.map : {}), [id]: value } }))
      }
    }
    void Promise.all([worker(), worker(), worker()])
    return () => {
      alive = false
    }
  }, [context, enabled])

  return state.context === context ? state.map : {}
}
