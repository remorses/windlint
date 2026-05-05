// Token name derivation: maps between CSS variable names and Tailwind utility class suffixes.
//
// In Tailwind CSS v4, CSS variables declared in @theme are automatically mapped to utility classes.
// The mapping strips the namespace prefix:
//   --color-social-apple  → utilities use "social-apple" (text-social-apple, bg-social-apple)
//   --color-primary       → utilities use "primary" (text-primary, bg-primary)
//   --shadow-fancy        → utilities use "fancy" (shadow-fancy)
//   --radius-lg           → utilities use "lg" (rounded-lg)
//
// This module handles parsing user input and computing these derived forms.

/**
 * Known Tailwind v4 theme namespaces and what they strip from utility names.
 * The key is the CSS variable prefix (without --), the value is the utility prefix
 * that Tailwind uses for that namespace.
 */
export const THEME_NAMESPACES = [
  'color',
  'shadow',
  'radius',
  'spacing',
  'font',
  'text',
  'tracking',
  'leading',
  'breakpoint',
  'container',
  'animate',
  'ease',
  'inset-shadow',
  'drop-shadow',
  'blur',
  'perspective',
] as const

export interface TokenPair {
  /** Full CSS variable name with --, e.g. "--color-social-apple" */
  cssVar: string
  /** CSS variable name without --, e.g. "color-social-apple" */
  cssVarName: string
  /** The namespace prefix, e.g. "color" */
  namespace: string
  /** The utility class suffix (namespace stripped), e.g. "social-apple" */
  utilitySuffix: string
  /** Optional Tailwind opacity/value modifier from targets like "color-primary/10" */
  utilityModifier?: string
}

/**
 * Parse a token name from user input.
 * Accepts formats like:
 *   "color-social-apple"       → --color-social-apple
 *   "--color-social-apple"     → --color-social-apple
 *   "social-apple"             → ambiguous, needs namespace hint
 */
export function parseToken(input: string, namespaceHint?: string): TokenPair {
  // Strip leading -- if present
  let rawName = input.startsWith('--') ? input.slice(2) : input
  let slashIndex = rawName.indexOf('/')
  let name = slashIndex === -1 ? rawName : rawName.slice(0, slashIndex)
  let utilityModifier = slashIndex === -1 ? undefined : rawName.slice(slashIndex + 1)

  // Try to detect namespace from the name
  let namespace = namespaceHint
  let utilitySuffix = name

  if (!namespace) {
    for (let ns of THEME_NAMESPACES) {
      if (name.startsWith(ns + '-')) {
        namespace = ns
        utilitySuffix = name.slice(ns.length + 1)
        break
      }
    }
  }

  // If no namespace detected, assume the full name is the utility suffix
  // and the user will need to provide the namespace
  if (!namespace) {
    namespace = ''
    utilitySuffix = name
  } else {
    utilitySuffix = name.slice(namespace.length + 1)
  }

  return {
    cssVar: `--${name}`,
    cssVarName: name,
    namespace,
    utilitySuffix,
    ...(utilityModifier ? { utilityModifier } : {}),
  }
}

/**
 * Given old and new token names, compute all the string replacements needed.
 */
export function computeReplacements(from: TokenPair, to: TokenPair) {
  return {
    // CSS variable declaration/reference: --color-social-apple → --color-primary
    cssVar: { from: from.cssVar, to: to.cssVar },
    // Utility class suffix: social-apple → primary
    utilitySuffix: { from: from.utilitySuffix, to: to.utilitySuffix },
  }
}
