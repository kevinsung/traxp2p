import { useState } from 'react'
import { copyText } from '../net/clipboard'

/**
 * A copy-to-clipboard button that gives feedback by swapping its own label
 * for a moment — no separate hint element, so it can't shuffle its neighbors.
 */
export function useCopyButton(label: string, copiedLabel: string) {
  const [copied, setCopied] = useState(false)

  async function click(text: string) {
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return { label: copied ? copiedLabel : label, click }
}
