import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export interface GitServiceOptions {
  repoPath?: string
  gitBinary?: string
  diffLimit?: number
  landscapeFileLimit?: number
  landscapeChangeLimit?: number
}

export interface GitHistoryApiOptions extends GitServiceOptions {
  readOnly?: boolean
  allowedRefs?: string[]
  publicRepository?: { name: string; displayPath: string }
  service?: unknown
  serviceFactory?: (options: GitServiceOptions) => unknown
}

export interface GitApiMiddleware {
  (request: IncomingMessage, response: ServerResponse, next?: () => void): void | Promise<void>
  readonly service: unknown
  dispose(options?: { force?: boolean }): Promise<void>
}

export const API_JSON_RESPONSE: unique symbol
export function createApiMiddleware(options?: GitHistoryApiOptions): GitApiMiddleware
export function gitHistoryApi(options?: GitHistoryApiOptions): Plugin
export default createApiMiddleware
