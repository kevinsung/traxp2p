/** Human-readable description of how a game ended, shared by GameScreen and Explorer. */
export function resultReasonText(reason: 'loop' | 'line' | 'resignation'): string {
  return reason === 'resignation'
    ? 'by resignation'
    : reason === 'loop'
      ? 'by completing a loop'
      : 'by completing a line across 8 rows'
}
