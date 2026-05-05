// String splicing utility for applying multiple text replacements by position.
// Adapted from Tailwind CSS upgrade tool's spliceChangesIntoString.

export interface StringChange {
  start: number
  end: number
  replacement: string
}

/**
 * Apply positional changes to a string without offset drift.
 * Changes are sorted by position and applied in order, building the result
 * string from left to right.
 */
export function spliceChangesIntoString(str: string, changes: StringChange[]): string {
  if (!changes[0]) return str

  // Sort all changes by position
  changes.sort((a, b) => a.end - b.end || a.start - b.start)

  let result = ''
  let previous = changes[0]!

  result += str.slice(0, previous.start)
  result += previous.replacement

  for (let i = 1; i < changes.length; ++i) {
    let change = changes[i]!

    result += str.slice(previous.end, change.start)
    result += change.replacement

    previous = change
  }

  // Add leftover string from last change to end
  result += str.slice(previous.end)

  return result
}
