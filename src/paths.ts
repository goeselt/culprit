import { isAbsolute, relative, resolve, sep } from 'node:path'

export function isWorkspaceFilePath(filePath: string, workspaceRoots: readonly string[]): boolean {
  const normalizedFile = normalizeAbsolutePath(filePath)
  if (!normalizedFile) return false

  return workspaceRoots.some((root) => {
    const normalizedRoot = normalizeAbsolutePath(root)
    if (!normalizedRoot) return false

    const rel = relative(normalizedRoot, normalizedFile)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

function normalizeAbsolutePath(path: string): string | undefined {
  if (!path || path.includes('\0') || !isAbsolute(path)) return undefined
  return resolve(path)
}
