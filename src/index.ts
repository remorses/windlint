// css-rename: programmatic API for renaming CSS variables/tokens in Tailwind projects.

export { rename, type RenameOptions, type RenameResult, type FileChange } from './rename.ts'
export { renameCssVariables } from './css-rename.ts'
export { renameTemplateTokens } from './template-rename.ts'
export { parseToken, computeReplacements, type TokenPair } from './token.ts'
export { discoverFiles } from './discover.ts'
