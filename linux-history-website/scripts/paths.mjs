import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const websiteRoot = fileURLToPath(new URL('../', import.meta.url))
export const workspaceRoot = path.resolve(websiteRoot, '..')
export const linuxRepository = 'https://github.com/torvalds/linux.git'
export const linuxDisplayUrl = 'https://github.com/torvalds/linux'
export const linuxRepoPath = path.resolve(process.env.LINUX_REPO || path.join(websiteRoot, 'data/linux.git'))
