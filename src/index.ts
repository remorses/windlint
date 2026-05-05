// windlint: programmatic API for linting and renaming Tailwind design tokens.

export { rename, type RenameOptions, type RenameResult, type FileChange } from './rename.ts'
export { countTokenUsage, formatTokenUsageTable, type TokenUsageResult, type TokenUsageRow } from './count.ts'
export { lint, formatLintResult, type LintDiagnostic, type LintOptions, type LintResult } from './lint.ts'
export { renameCssVariables, renameApplyDirectives } from './css-rename.ts'
export { renameTemplateTokens } from './template-rename.ts'
export { parseToken, computeReplacements, type TokenPair } from './token.ts'
export { discoverFiles } from './discover.ts'
