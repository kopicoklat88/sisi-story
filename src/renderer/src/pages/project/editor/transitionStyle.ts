import type { CSSProperties } from 'react'
import type { TransitionId } from '@shared/types'

/**
 * How the outgoing clip (prev, drawn on top) and the incoming clip (cur) look at transition progress k
 * (0 to 1). Matches the FFmpeg xfade transitions of the export closely enough to judge them in the preview.
 */
export function transitionStyles(transition: TransitionId, k: number): { prev: CSSProperties; cur: CSSProperties } {
  if (transition === 'slideleft') return { prev: { transform: `translateX(${-k * 100}%)` }, cur: { transform: `translateX(${(1 - k) * 100}%)` } }
  if (transition === 'zoomin') return { prev: { transform: `scale(${1 + k * 0.6})`, opacity: 1 - k }, cur: {} }
  // Whip: the outgoing clip is flung off sideways with a zoom punch; the incoming one slides in behind it.
  if (transition === 'whip')
    return {
      prev: { transform: `translateX(${-k * 100}%) scale(${1 + k * 0.15})` },
      cur: { transform: `translateX(${(1 - k) * 100}%)` }
    }
  // Iris: the outgoing clip closes as a circle from the centre, revealing the incoming clip.
  if (transition === 'iris') return { prev: { clipPath: `circle(${(1 - k) * 100}% at 50% 50%)` }, cur: {} }
  return { prev: { opacity: 1 - k }, cur: {} }
}
