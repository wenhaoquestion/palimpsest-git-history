const vscode = require('vscode')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const VIEW_TYPE = 'palimpsest.history'
const SAVED_REPOSITORY = 'palimpsest.repositoryPath'
const MAX_REQUESTS = 16
let currentPanel
let rpcModule
let commandQueue = Promise.resolve()

function trusted() {
  if (vscode.workspace.isTrusted) return true
  void vscode.window.showWarningMessage('Trust this workspace before running Git history visualization.')
  return false
}

async function findGitRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null
  let folder = candidate
  try {
    if (!(await fs.stat(folder)).isDirectory()) folder = path.dirname(folder)
  } catch { return null }
  while (true) {
    if (await isRepositoryRoot(folder)) return folder
    const parent = path.dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
}

async function isRepositoryRoot(folder) {
  try {
    const marker = await fs.stat(path.join(folder, '.git'))
    if (marker.isDirectory() || marker.isFile()) return true
  } catch { /* Bare repositories store Git metadata directly at the root. */ }
  try {
    const [head, objects, refs] = await Promise.all(['HEAD', 'objects', 'refs'].map((name) => fs.stat(path.join(folder, name))))
    return head.isFile() && objects.isDirectory() && refs.isDirectory()
  } catch { return false }
}

async function workspaceRepositories() {
  const roots = new Map()
  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
    const root = await findGitRoot(folder.uri.fsPath)
    if (root) roots.set(root, { label: path.basename(root), description: root, repoPath: root })
    // One bounded directory listing also discovers common multi-project workspaces.
    try {
      const candidates = []
      let examined = 0
      for await (const entry of await fs.opendir(folder.uri.fsPath)) {
        if (++examined > 1024) break
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') candidates.push(entry)
        if (candidates.length === 128) break
      }
      await Promise.all(candidates.map(async (entry) => {
        const candidate = path.join(folder.uri.fsPath, entry.name)
        if (await isRepositoryRoot(candidate)) roots.set(candidate, { label: entry.name, description: candidate, repoPath: candidate })
      }))
    } catch { /* An unavailable workspace folder does not hide the folder picker. */ }
  }))
  return [...roots.values()].sort((a, b) => a.description.localeCompare(b.description))
}

async function pickRepository(context, forcePicker, resource) {
  if (resource?.fsPath) {
    const root = await findGitRoot(resource.fsPath)
    if (root) return root
  }
  if (!forcePicker) {
    const remembered = await findGitRoot(context.workspaceState.get(SAVED_REPOSITORY))
    if (remembered) return remembered
  }
  const repositories = await workspaceRepositories()
  if (!forcePicker && repositories.length === 1) return repositories[0].repoPath
  if (repositories.length) {
    const choice = await vscode.window.showQuickPick([
      ...repositories,
      { label: '$(folder-opened) Browse for a repository…', description: 'Choose another folder' },
    ], { title: 'Palimpsest: choose a Git repository', matchOnDescription: true })
    if (!choice) return null
    if (choice.repoPath) return choice.repoPath
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: 'Visualize Git history', title: 'Choose a Git repository',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  })
  if (!selected?.[0]) return null
  const root = await findGitRoot(selected[0].fsPath)
  if (!root) await vscode.window.showErrorMessage('This folder is not inside a Git repository. Choose a folder containing .git.')
  return root
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

async function webviewHtml(context, webview) {
  const dist = vscode.Uri.joinPath(context.extensionUri, 'dist')
  const nonce = randomBytes(24).toString('base64')
  let html = await fs.readFile(path.join(context.extensionPath, 'dist', 'index.html'), 'utf8')
  html = html.replace(/\b(src|href)="([^"#]+)"/g, (_match, attribute, source) => {
    const asset = source.replace(/^\.\//, '').replace(/^\//, '')
    if (!asset || asset.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/i.test(asset)) {
      throw new Error(`Unsupported webview asset: ${source}`)
    }
    return `${attribute}="${escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(dist, asset)).toString())}"`
  }).replace(/<script\b/g, `<script nonce="${nonce}"`)
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`
  return html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`)
}

class HistoryPanel {
  constructor(context, repoPath, panel) {
    this.context = context
    this.repoPath = repoPath
    this.pending = new Map()
    this.client = null
    this.generation = 0
    this.recoveredRepositoryId = undefined
    this.disposed = false
    this.switching = false
    this.idleTimer = null
    this.panel = panel ?? vscode.window.createWebviewPanel(VIEW_TYPE, 'Palimpsest', vscode.ViewColumn.Active, {})
    this.lastVisible = this.panel.visible
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    }
    this.panel.title = `Palimpsest · ${path.basename(repoPath)}`
    this.disposables = [
      this.panel.webview.onDidReceiveMessage((message) => { void this.receive(message) }),
      this.panel.onDidChangeViewState(() => this.visibilityChanged()),
      this.panel.onDidDispose(() => { void this.dispose() }),
    ]
  }

  async initialize() {
    await this.context.workspaceState.update(SAVED_REPOSITORY, this.repoPath)
    const html = await webviewHtml(this.context, this.panel.webview)
    if (!this.disposed) this.panel.webview.html = html
  }

  post(message) {
    if (!this.disposed) void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined)
  }

  cancelRequests() {
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }

  async releaseWorker() {
    this.generation += 1
    this.recoveredRepositoryId = undefined
    this.cancelRequests()
    const client = this.client
    this.client = null
    if (client) await client.dispose()
  }

  async ensureClient(generation) {
    if (!rpcModule) rpcModule = import(pathToFileURL(path.join(this.context.extensionPath, 'server', 'rpc-client.mjs')).href)
    const { createRpcClient } = await rpcModule
    if (this.disposed || generation !== this.generation || !this.panel.visible || !vscode.workspace.isTrusted) {
      throw Object.assign(new Error('The history view is no longer active.'), { name: 'AbortError' })
    }
    if (!this.client) {
      this.client = createRpcClient({
        repoPath: this.repoPath,
        maxHeapMb: vscode.workspace.getConfiguration('palimpsest').get('workerMaxHeapMb', 384),
      })
    }
    return this.client
  }

  async receive(message) {
    if (!message || typeof message !== 'object' || this.disposed) return
    if (message.type === 'palimpsest:cancel') {
      this.pending.get(message.id)?.abort()
      return
    }
    if (message.type === 'palimpsest:pickRepository') {
      await vscode.commands.executeCommand('palimpsest.openRepository')
      return
    }
    if (message.type !== 'palimpsest:request' || typeof message.id !== 'string' || !message.id || message.id.length > 128) return
    const reply = (status, body) => this.post({ type: 'palimpsest:response', id: message.id, status, body })
    if (!vscode.workspace.isTrusted) return reply(403, { message: 'Workspace trust is required to run Git.' })
    if (this.switching) return reply(409, { message: 'The selected repository is changing.' })
    if (!this.panel.visible) return reply(409, { message: 'The history view is paused while hidden.' })
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/') || message.url.length > 8192
      || !['GET', 'POST'].includes(message.method ?? 'GET')
      || (message.body !== undefined && (typeof message.body !== 'string' || message.body.length > 65536))) {
      return reply(400, { message: 'Invalid history request.' })
    }
    if (this.pending.has(message.id) || this.pending.size >= MAX_REQUESTS) {
      return reply(429, { message: 'Too many pending history requests. Try again shortly.' })
    }
    const controller = new AbortController()
    const generation = this.generation
    this.pending.set(message.id, controller)
    try {
      const client = await this.ensureClient(generation)
      const result = await client.request({ url: message.url, method: message.method ?? 'GET', body: message.body }, controller.signal)
      if (!controller.signal.aborted && generation === this.generation) {
        if (result.status === 409 && result.body?.error?.code === 'REPOSITORY_CHANGED') {
          const staleId = new URL(message.url, 'http://localhost').searchParams.get('repository')
          if (staleId !== this.recoveredRepositoryId) {
            this.recoveredRepositoryId = staleId
            this.generation += 1
            // Complete stale webview promises before cancelling their backend
            // work. A native repository candidate has a Symbol key and can
            // finish independently of this recovery.
            for (const [id, pending] of this.pending) {
              if (typeof id !== 'string') continue
              this.post({ type: 'palimpsest:response', id, status: 409, body: result.body })
              pending.abort()
              this.pending.delete(id)
            }
            this.post({ type: 'palimpsest:repositoryChanged', repoPath: this.repoPath })
            return
          }
        }
        reply(result.status, result.body)
      }
    } catch (error) {
      if (!controller.signal.aborted && error.name !== 'AbortError' && generation === this.generation) {
        reply(500, { message: error instanceof Error ? error.message : 'Could not read Git history.' })
      }
    } finally {
      if (this.pending.get(message.id) === controller) this.pending.delete(message.id)
    }
  }

  visibilityChanged() {
    // Activation and editor-column changes also emit this event. Only an
    // actual hide/show cycle should pause or reload the history view.
    if (this.lastVisible === this.panel.visible) return
    this.lastVisible = this.panel.visible
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.post({ type: 'palimpsest:visibility', visible: this.panel.visible })
    if (this.panel.visible) {
      this.post({ type: 'palimpsest:repositoryChanged', repoPath: this.repoPath })
      return
    }
    this.cancelRequests()
    const seconds = vscode.workspace.getConfiguration('palimpsest').get('workerIdleSeconds', 30)
    this.idleTimer = setTimeout(() => { void this.releaseWorker() }, Math.max(0, seconds) * 1000)
    this.idleTimer.unref?.()
  }

  async changeRepository(repoPath) {
    if (!rpcModule) rpcModule = import(pathToFileURL(path.join(this.context.extensionPath, 'server', 'rpc-client.mjs')).href)
    const { createRpcClient } = await rpcModule
    if (this.disposed || !vscode.workspace.isTrusted) return
    const candidate = createRpcClient({
      repoPath,
      maxHeapMb: vscode.workspace.getConfiguration('palimpsest').get('workerMaxHeapMb', 384),
    })
    const validationKey = Symbol('repository-validation')
    const controller = new AbortController()
    this.pending.set(validationKey, controller)
    try {
      const result = await candidate.request({ url: '/api/repository?stats=false', method: 'GET' }, controller.signal)
      if (result.status >= 400 || !['ready', 'empty'].includes(result.body?.status)) {
        throw new Error(result.body?.message ?? 'This folder could not be opened as a Git repository.')
      }
      if (controller.signal.aborted || this.disposed || !vscode.workspace.isTrusted) {
        throw Object.assign(new Error('Repository selection was cancelled.'), { name: 'AbortError' })
      }
      this.pending.delete(validationKey)
      this.switching = true
      await this.releaseWorker()
      if (this.disposed) throw Object.assign(new Error('The history view was closed.'), { name: 'AbortError' })
      this.client = candidate
      this.repoPath = repoPath
    } catch (error) {
      await candidate.dispose()
      if (error.name !== 'AbortError') throw error
      return
    } finally {
      this.pending.delete(validationKey)
      this.switching = false
    }
    this.panel.title = `Palimpsest · ${path.basename(repoPath)}`
    await this.context.workspaceState.update(SAVED_REPOSITORY, repoPath)
    const wasVisible = this.panel.visible
    this.panel.reveal()
    if (wasVisible) this.post({ type: 'palimpsest:repositoryChanged', repoPath })
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.idleTimer)
    for (const subscription of this.disposables) subscription.dispose()
    if (currentPanel === this) currentPanel = undefined
    await this.releaseWorker()
  }
}

function activate(context) {
  const run = (operation) => {
    commandQueue = commandQueue.then(async () => {
      if (trusted()) await operation()
    }).catch((error) => { void vscode.window.showErrorMessage(`Palimpsest: ${error.message ?? error}`) })
    return commandQueue
  }
  const open = async (forcePicker = false, resource) => {
    if (currentPanel && !forcePicker) return currentPanel.panel.reveal()
    const repoPath = await pickRepository(context, forcePicker, resource)
    if (!repoPath || !vscode.workspace.isTrusted) return
    if (currentPanel) return currentPanel.changeRepository(repoPath)
    const view = new HistoryPanel(context, repoPath)
    currentPanel = view
    try { await view.initialize() } catch (error) { view.panel.dispose(); throw error }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('palimpsest.open', () => run(() => open())),
    vscode.commands.registerCommand('palimpsest.openRepository', (resource) => run(() => open(true, resource))),
    vscode.commands.registerCommand('palimpsest.refresh', () => run(async () => {
      if (!currentPanel) return open()
      await currentPanel.changeRepository(currentPanel.repoPath)
    })),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        if (!vscode.workspace.isTrusted || currentPanel) return panel.dispose()
        const remembered = await findGitRoot(context.workspaceState.get(SAVED_REPOSITORY))
        const repoPath = remembered ?? (await workspaceRepositories())[0]?.repoPath
        if (!repoPath || currentPanel) return panel.dispose()
        const view = new HistoryPanel(context, repoPath, panel)
        currentPanel = view
        try { await view.initialize() } catch (error) { panel.dispose(); throw error }
      },
    }),
  )
}

async function deactivate() {
  await currentPanel?.dispose()
}

module.exports = { activate, deactivate }
