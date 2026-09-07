const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function event() {
  const listeners = new Set()
  return {
    subscribe: (callback) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) } },
    emit: (value) => { for (const callback of [...listeners]) callback(value) },
  }
}

async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Extension event timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function fixture(t, { trusted = true, idleSeconds = 0, floatingWindows = true, launcherVisible = false } = {}) {
  const folder = await fs.mkdtemp(path.join(tmpdir(), 'palimpsest-extension-'))
  const repository = path.join(folder, 'repository')
  await fs.mkdir(path.join(repository, '.git'), { recursive: true })
  await fs.mkdir(path.join(folder, 'dist'), { recursive: true })
  await fs.mkdir(path.join(folder, 'server'), { recursive: true })
  await fs.writeFile(path.join(folder, 'dist', 'index.html'), '<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>')
  const token = `palimpsest-test-${path.basename(folder)}`
  const io = { clients: [], requests: 0, aborted: 0, disposed: 0 }
  globalThis[token] = io
  await fs.writeFile(path.join(folder, 'server', 'rpc-client.mjs'), `
    const io = globalThis[${JSON.stringify(token)}];
    export function createRpcClient(options) {
      io.clients.push(options);
      return {
        request: async ({url, method, body}, signal) => {
          io.requests++;
          if (signal?.aborted) throw signal.reason;
          if (io.requestHook) {
            const result = await io.requestHook({url, method, body, signal, options});
            if (result !== undefined) return result;
          }
          if (options.repoPath.endsWith('invalid')) return {status:500,body:{message:'Invalid Git metadata'}};
          if(url.includes('slow')) return new Promise((resolve,reject) => {
            signal.addEventListener('abort',()=>{io.aborted++; reject(signal.reason)}, {once:true});
          });
          return {status:200,body:{status:'ready',repoPath:options.repoPath}};
        },
        dispose: async () => {io.disposed++}
      };
    }
  `)
  const commands = new Map()
  const panels = []
  const notifications = []
  const stored = new Map()
  const views = new Map()
  const treeViews = new Map()
  const executed = []
  let serializer
  const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` })
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { Active: -1, Beside: -2 },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: [{ name: 'repository', uri: uri(repository) }],
      getConfiguration: () => ({ get: (name, fallback) => name === 'workerIdleSeconds' ? idleSeconds : fallback }),
    },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} } },
      getCommands: async () => [...commands.keys(), ...(floatingWindows ? ['workbench.action.moveEditorToNewWindow'] : [])],
      executeCommand: async (name, ...args) => {
        if (commands.has(name)) return commands.get(name)(...args)
        executed.push({ name, args })
        return io.commandHook?.(name, ...args)
      },
    },
    window: {
      showWarningMessage: async (text) => notifications.push(text),
      showErrorMessage: async (text) => notifications.push(text),
      showInformationMessage: async (text) => notifications.push(text),
      showQuickPick: async (items) => items[0],
      showOpenDialog: async () => [uri(repository)],
      registerWebviewPanelSerializer: (_type, value) => { serializer = value; return { dispose() {} } },
      createTreeView: (id, options) => {
        const visibility = event()
        views.set(id, options.treeDataProvider)
        const view = {
          visible: launcherVisible,
          onDidChangeVisibility: visibility.subscribe,
          setVisible(value) { this.visible = value; visibility.emit({ visible: value }) },
          dispose() { views.delete(id); treeViews.delete(id) },
        }
        treeViews.set(id, view)
        return view
      },
      createWebviewPanel: (type, title, column, options) => {
        const receive = event()
        const change = event()
        const dispose = event()
        const messages = []
        const panel = {
          type, title, column, options, visible: true, active: true, revealCount: 0,
          webview: {
            cspSource: 'vscode-webview://test', messages,
            asWebviewUri: (asset) => ({ toString: () => `vscode-resource://${asset.fsPath}` }),
            onDidReceiveMessage: receive.subscribe,
            postMessage: async (message) => { messages.push(message); return true },
          },
          reveal(column) { this.revealCount++; this.visible = true; this.active = true; if (column !== undefined) this.column = column; change.emit({ webviewPanel: this }) },
          onDidChangeViewState: change.subscribe,
          onDidDispose: dispose.subscribe,
          dispose: () => dispose.emit(),
          receive: receive.emit,
          setVisible(value) { this.visible = value; this.active = value; change.emit({ webviewPanel: this }) },
        }
        panels.push(panel)
        return panel
      },
    },
  }
  const context = {
    extensionPath: folder, extensionUri: uri(folder), subscriptions: [],
    workspaceState: { get: (key) => stored.get(key), update: async (key, value) => stored.set(key, value) },
  }
  const filename = path.join(__dirname, 'extension.cjs')
  const extensionModule = new Module(filename)
  extensionModule.filename = filename
  extensionModule.paths = Module._nodeModulePaths(__dirname)
  const requireOriginal = extensionModule.require.bind(extensionModule)
  extensionModule.require = (specifier) => specifier === 'vscode' ? vscode : requireOriginal(specifier)
  extensionModule._compile(readFileSync(filename, 'utf8'), filename)
  extensionModule.exports.activate(context)
  t.after(async () => {
    await extensionModule.exports.deactivate()
    delete globalThis[token]
    await fs.rm(folder, { recursive: true, force: true })
  })
  return { folder, repository, commands, panels, io, notifications, context, uri, vscode, serializer, views, treeViews, executed, deactivate: extensionModule.exports.deactivate }
}

test('opens one lazy webview with only packaged resources and a nonce CSP', async (t) => {
  const app = await fixture(t)
  await app.commands.get('palimpsest.open')()
  await app.commands.get('palimpsest.open')()
  assert.equal(app.panels.length, 1)
  assert.equal(app.io.clients.length, 0)
  const panel = app.panels[0]
  assert.equal(panel.webview.messages.length, 0, 'focusing an already visible editor must not reload it')
  assert.equal(panel.options.retainContextWhenHidden, undefined)
  assert.equal(panel.webview.options.localResourceRoots.length, 1)
  assert.match(panel.webview.html, /connect-src &#39;none&#39;/)
  assert.match(panel.webview.html, /<script nonce="[^"]+"/)
  assert.match(panel.webview.html, /vscode-resource:.*\/dist\/assets\/app.js/)
  panel.receive({ type: 'palimpsest:request', id: 'first', url: '/api/repository', method: 'GET' })
  await until(() => panel.webview.messages.some((message) => message.id === 'first'))
  assert.equal(app.io.clients.length, 1)
  assert.deepEqual(panel.webview.messages.find((message) => message.id === 'first').body, { status: 'ready', repoPath: app.repository })
})

test('hidden views cancel requests, release workers, and restart lazily when shown', async (t) => {
  const app = await fixture(t)
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'slow', url: '/api/slow', method: 'GET' })
  await until(() => app.io.requests === 1)
  panel.setVisible(false)
  await until(() => app.io.disposed === 1)
  assert.equal(app.io.aborted, 1)
  panel.setVisible(true)
  assert.ok(panel.webview.messages.some((message) => message.type === 'palimpsest:repositoryChanged'))
  panel.receive({ type: 'palimpsest:request', id: 'resumed', url: '/api/repository', method: 'GET' })
  await until(() => app.io.clients.length === 2)
  panel.dispose()
  await until(() => app.io.disposed === 2)
})

test('native repository selection disposes the old worker before serving the new root', async (t) => {
  const app = await fixture(t)
  const second = path.join(app.folder, 'second')
  await fs.mkdir(path.join(second, '.git'), { recursive: true })
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'first', url: '/api/repository', method: 'GET' })
  await until(() => app.io.requests === 1)
  await app.commands.get('palimpsest.openRepository')(app.uri(second))
  assert.equal(app.io.disposed, 1)
  assert.equal(app.panels.length, 1)
  panel.receive({ type: 'palimpsest:request', id: 'second', url: '/api/repository', method: 'GET' })
  await until(() => app.io.clients.length === 2)
  assert.equal(app.io.clients[1].repoPath, second)
})

test('untrusted workspaces cannot create a view or start a Git worker', async (t) => {
  const app = await fixture(t, { trusted: false })
  await app.commands.get('palimpsest.open')()
  assert.equal(app.panels.length, 0)
  assert.equal(app.io.clients.length, 0)
  assert.match(app.notifications[0], /Trust this workspace/)
})

test('rejects excess and malformed bridge requests without unbounded host queues', async (t) => {
  const app = await fixture(t)
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  for (let index = 0; index < 20; index++) {
    panel.receive({ type: 'palimpsest:request', id: `slow-${index}`, url: '/api/slow', method: 'GET' })
  }
  panel.receive({ type: 'palimpsest:request', id: 'bad', url: 'https://example.com', method: 'GET' })
  await until(() => app.io.requests === 16)
  assert.equal(panel.webview.messages.filter((message) => message.status === 429).length, 4)
  assert.equal(panel.webview.messages.find((message) => message.id === 'bad').status, 400)
})


test('a failed candidate repository preserves the current worker and saved selection', async (t) => {
  const app = await fixture(t)
  const invalid = path.join(app.folder, 'invalid')
  await fs.mkdir(path.join(invalid, '.git'), { recursive: true })
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'original', url: '/api/repository', method: 'GET' })
  await until(() => app.io.requests === 1)
  await app.commands.get('palimpsest.openRepository')(app.uri(invalid))
  assert.match(app.notifications[0], /Invalid Git metadata/)
  assert.equal(app.io.disposed, 1)
  assert.equal(app.context.workspaceState.get('palimpsest.repositoryPath'), app.repository)
  panel.receive({ type: 'palimpsest:request', id: 'retained', url: '/api/repository', method: 'GET' })
  await until(() => panel.webview.messages.some((message) => message.id === 'retained'))
  assert.equal(panel.webview.messages.find((message) => message.id === 'retained').body.repoPath, app.repository)
  assert.equal(app.io.clients.length, 2)
})

test('bare repositories are detected without invoking Git in the extension host', async (t) => {
  const app = await fixture(t)
  const bare = path.join(app.folder, 'bare.git')
  await fs.mkdir(path.join(bare, 'objects'), { recursive: true })
  await fs.mkdir(path.join(bare, 'refs'), { recursive: true })
  await fs.writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n')
  app.vscode.workspace.workspaceFolders = [{ name: 'bare', uri: app.uri(bare) }]
  await app.commands.get('palimpsest.open')()
  assert.equal(app.panels.length, 1)
  assert.equal(app.context.workspaceState.get('palimpsest.repositoryPath'), bare)
  assert.equal(app.io.clients.length, 0)
})

test('a restarted backend reloads its session once and completes all stale webview requests', async (t) => {
  const app = await fixture(t)
  let repositoryId = 'before-crash'
  const outstanding = new Map()
  const changed = { status: 409, body: { error: { code: 'REPOSITORY_CHANGED', message: 'Reload the repository.' } } }
  app.io.requestHook = ({ url, signal }) => {
    const parsed = new URL(url, 'http://localhost')
    if (parsed.pathname === '/api/repository') return { status: 200, body: { status: 'ready', repositoryId } }
    if (parsed.searchParams.get('repository') === repositoryId) return { status: 200, body: { items: [] } }
    if (parsed.pathname === '/api/late') return changed
    return new Promise((resolve, reject) => {
      outstanding.set(parsed.pathname, resolve)
      signal.addEventListener('abort', () => { app.io.aborted++; reject(signal.reason) }, { once: true })
    })
  }
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  const request = (id, url) => panel.receive({ type: 'palimpsest:request', id, url, method: 'GET' })
  const responses = (id) => panel.webview.messages.filter((message) => message.id === id)
  const reloads = () => panel.webview.messages.filter((message) => message.type === 'palimpsest:repositoryChanged')
  request('initial', '/api/repository?stats=false')
  await until(() => responses('initial').length === 1)
  repositoryId = 'after-crash'
  request('stale-one', '/api/commits?repository=before-crash')
  request('stale-two', '/api/tree/abc?repository=before-crash')
  request('stale-pending', '/api/diff/abc?repository=before-crash')
  await until(() => outstanding.size === 3)
  outstanding.get('/api/commits')(changed)
  outstanding.get('/api/tree/abc')(changed)
  await until(() => reloads().length === 1)
  for (const id of ['stale-one', 'stale-two', 'stale-pending']) {
    assert.equal(responses(id).length, 1, `${id} must be settled exactly once`)
    assert.equal(responses(id)[0].status, 409)
  }
  assert.equal(app.io.aborted, 3)

  // Late requests carrying the same obsolete session cannot cause a reload
  // storm, while an unscoped repository request is immediately admitted.
  request('late', '/api/late?repository=before-crash')
  request('reloaded', '/api/repository?stats=false')
  await until(() => responses('late').length === 1 && responses('reloaded').length === 1)
  assert.equal(reloads().length, 1)
  assert.equal(responses('reloaded')[0].body.repositoryId, 'after-crash')
  request('resumed', '/api/commits?repository=after-crash')
  await until(() => responses('resumed').length === 1)
  assert.equal(responses('resumed')[0].status, 200)
  assert.equal(app.io.clients.length, 1, 'the already restarted backend is reused')
  assert.equal(app.io.disposed, 0)

  repositoryId = 'after-another-crash'
  request('another-crash', '/api/late?repository=after-crash')
  await until(() => reloads().length === 2)
})

test('other conflicts and caller cancellations do not trigger repository recovery', async (t) => {
  const app = await fixture(t)
  app.io.requestHook = ({ url }) => url === '/api/conflict'
    ? { status: 409, body: { error: { code: 'EMPTY_REPOSITORY', message: 'There are no commits.' } } }
    : undefined
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'conflict', url: '/api/conflict', method: 'GET' })
  panel.receive({ type: 'palimpsest:request', id: 'cancelled', url: '/api/slow', method: 'GET' })
  await until(() => app.io.requests === 2)
  panel.receive({ type: 'palimpsest:cancel', id: 'cancelled' })
  await until(() => app.io.aborted === 1)
  assert.equal(panel.webview.messages.find((message) => message.id === 'conflict').status, 409)
  assert.equal(panel.webview.messages.some((message) => message.id === 'cancelled'), false)
  assert.equal(panel.webview.messages.some((message) => message.type === 'palimpsest:repositoryChanged'), false)
})

test('the native Activity Bar launcher stays lightweight until an action opens the workbench', async (t) => {
  const app = await fixture(t)
  const manifest = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  const container = manifest.contributes.viewsContainers.activitybar.find((item) => item.id === 'palimpsest')
  assert.ok(container)
  assert.ok(readFileSync(path.join(__dirname, container.icon), 'utf8').includes('<svg'))
  assert.equal(app.views.get('palimpsest.launcher').getChildren().length, 0)
  assert.equal(app.panels.length, 0)
  assert.equal(app.io.clients.length, 0)
  for (const item of manifest.contributes.commands) assert.ok(app.commands.has(item.command), item.command)
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.contents.includes('command:palimpsest.openChanges')))
})

test('clicking the Activity Bar opens the workbench once and subsequent genuine visits reveal it', async (t) => {
  const app = await fixture(t)
  const launcher = app.treeViews.get('palimpsest.launcher')
  launcher.setVisible(true)
  await until(() => !!app.panels[0]?.webview.html)
  const panel = app.panels[0]
  launcher.setVisible(true)
  launcher.setVisible(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.panels.length, 1)
  assert.equal(panel.revealCount, 0, 'Duplicate visible notifications cannot loop into repeated opens')
  launcher.setVisible(false)
  launcher.setVisible(true)
  await until(() => panel.revealCount === 1)
  assert.equal(app.panels.length, 1)
  assert.equal(app.io.clients.length, 0, 'The launcher does not start an extra worker')
})

test('a launcher already visible when the extension activates opens without a second click', async (t) => {
  const app = await fixture(t, { launcherVisible: true })
  await until(() => !!app.panels[0]?.webview.html)
  assert.equal(app.panels.length, 1)
  app.treeViews.get('palimpsest.launcher').setVisible(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.panels[0].revealCount, 0)
})

test('a cancelled repository picker does not reopen from duplicate or in-flight visibility events', async (t) => {
  const app = await fixture(t)
  app.vscode.workspace.workspaceFolders = []
  let calls = 0
  let cancel
  app.vscode.window.showOpenDialog = async () => {
    calls += 1
    if (calls === 1) return new Promise((resolve) => { cancel = () => resolve(undefined) })
    return undefined
  }
  const launcher = app.treeViews.get('palimpsest.launcher')
  launcher.setVisible(true)
  await until(() => calls === 1)
  launcher.setVisible(false)
  launcher.setVisible(true)
  launcher.setVisible(true)
  cancel()
  await new Promise((resolve) => setTimeout(resolve, 15))
  launcher.setVisible(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(app.panels.length, 0)
  launcher.setVisible(false)
  launcher.setVisible(true)
  await until(() => calls === 2)
  assert.equal(app.panels.length, 0)
})

test('the Activity Bar respects workspace trust without repeatedly prompting for it', async (t) => {
  const app = await fixture(t, { trusted: false, launcherVisible: true })
  const launcher = app.treeViews.get('palimpsest.launcher')
  launcher.setVisible(false)
  launcher.setVisible(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(app.panels.length, 0)
  assert.equal(app.io.clients.length, 0)
  assert.deepEqual(app.notifications, [])
  app.vscode.workspace.isTrusted = true
  launcher.setVisible(false)
  launcher.setVisible(true)
  await until(() => !!app.panels[0]?.webview.html)
  assert.equal(app.panels.length, 1)
})

test('opening a native floating window focuses and moves the existing workbench once', async (t) => {
  const app = await fixture(t)
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.active = false
  app.io.commandHook = (name) => {
    assert.equal(name, 'workbench.action.moveEditorToNewWindow')
    assert.equal(panel.active, true, 'The Palimpsest editor must be focused before moving it')
  }
  await app.commands.get('palimpsest.openInNewWindow')()
  assert.equal(app.panels.length, 1)
  assert.equal(app.executed.length, 1)
  assert.equal(app.io.clients.length, 0)
  panel.receive({ type: 'palimpsest:openToSide' })
  await until(() => panel.column === app.vscode.ViewColumn.Beside)
})

test('unavailable and rejected floating-window commands preserve the workbench beside the editor', async (t) => {
  const missing = await fixture(t, { floatingWindows: false })
  await missing.commands.get('palimpsest.openInNewWindow')()
  assert.equal(missing.panels[0].column, missing.vscode.ViewColumn.Beside)
  assert.equal(missing.executed.length, 0)
  assert.match(missing.notifications[0], /open beside your editor/)

  const failed = await fixture(t)
  await failed.commands.get('palimpsest.open')()
  failed.panels[0].receive({ type: 'palimpsest:ready' })
  failed.io.commandHook = () => { throw new Error('Floating windows unavailable') }
  await failed.commands.get('palimpsest.openInNewWindow')()
  assert.equal(failed.panels.length, 1)
  assert.equal(failed.panels[0].column, failed.vscode.ViewColumn.Beside)
  assert.match(failed.notifications[0], /open beside your editor/)
  await failed.commands.get('palimpsest.openChanges')()
  assert.ok(failed.panels[0].webview.messages.some((message) => message.type === 'palimpsest:showWorkspace'), 'Failed moves must preserve the existing readiness handshake')
})

test('Open Changes waits for webview readiness and survives a floating-window reload', async (t) => {
  const app = await fixture(t)
  await app.commands.get('palimpsest.openChanges')()
  const panel = app.panels[0]
  const shows = () => panel.webview.messages.filter((message) => message.type === 'palimpsest:showWorkspace')
  assert.equal(shows().length, 0)
  panel.receive({ type: 'palimpsest:ready' })
  assert.equal(shows().length, 1)
  await app.commands.get('palimpsest.openInNewWindow')()
  await app.commands.get('palimpsest.openChanges')()
  assert.equal(shows().length, 1)
  panel.receive({ type: 'palimpsest:ready' })
  assert.equal(shows().length, 2)
  await app.commands.get('palimpsest.openChanges')()
  assert.equal(shows().length, 3)
})

test('the bridge admits bounded workbench writes and rejects arbitrary POST routes and repository paths', async (t) => {
  const app = await fixture(t)
  let forwarded
  app.io.requestHook = (request) => { forwarded = request }
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'stage', method: 'POST', url: '/api/workspace/stage?repository=current', body: '{"paths":["src/file.ts"]}' })
  await until(() => panel.webview.messages.some((message) => message.id === 'stage'))
  assert.equal(forwarded.method, 'POST')
  assert.deepEqual(JSON.parse(forwarded.body), { paths: ['src/file.ts'] })
  for (const [id, url] of [['switch', '/api/repository'], ['unknown', '/api/workspace/run'], ['normalized', '/api/workspace/../repository']]) {
    panel.receive({ type: 'palimpsest:request', id, method: 'POST', url, body: '{"path":"/private/another-repository"}' })
    assert.equal(panel.webview.messages.find((message) => message.id === id).status, 405)
  }
  assert.equal(app.io.requests, 1)
})

async function pendingMutation(app) {
  let finish
  let signal
  app.io.requestHook = (request) => {
    if (request.url.includes('/api/workspace/commit')) {
      signal = request.signal
      return new Promise((resolve) => { finish = () => resolve({ status: 200, body: { repositoryChanged: true, repositoryId: 'after-commit' } }) })
    }
  }
  await app.commands.get('palimpsest.open')()
  const panel = app.panels[0]
  panel.receive({ type: 'palimpsest:request', id: 'commit', method: 'POST', url: '/api/workspace/commit', body: '{"message":"Save change"}' })
  await until(() => !!finish)
  return { panel, signal, finish }
}

test('hidden views and caller cancellation retain a running mutation until it settles', async (t) => {
  const app = await fixture(t)
  const { panel, signal, finish } = await pendingMutation(app)
  panel.receive({ type: 'palimpsest:cancel', id: 'commit' })
  panel.receive({ type: 'palimpsest:request', id: 'second-write', method: 'POST', url: '/api/refresh' })
  assert.equal(panel.webview.messages.find((message) => message.id === 'second-write').status, 409)
  panel.setVisible(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(app.io.disposed, 0)
  assert.equal(signal.aborted, false)
  finish()
  await until(() => app.io.disposed === 1)
  assert.equal(app.io.requests, 1, 'Cancellation must not retry the commit')
})

test('showing a panel before its mutation finishes cancels the pending idle release', async (t) => {
  const app = await fixture(t)
  const { panel, finish } = await pendingMutation(app)
  panel.setVisible(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  panel.setVisible(true)
  finish()
  await until(() => panel.webview.messages.some((message) => message.id === 'commit'))
  assert.equal(app.io.disposed, 0)
})

test('native repository changes wait for the current mutation and then release its worker', async (t) => {
  const app = await fixture(t)
  const second = path.join(app.folder, 'second')
  await fs.mkdir(path.join(second, '.git'), { recursive: true })
  const { signal, finish } = await pendingMutation(app)
  const switching = app.commands.get('palimpsest.openRepository')(app.uri(second))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(app.io.clients.length, 1)
  assert.equal(signal.aborted, false)
  finish()
  await switching
  assert.equal(app.io.clients.length, 2)
  assert.equal(app.io.disposed, 1)
  assert.equal(app.context.workspaceState.get('palimpsest.repositoryPath'), second)
})

test('closing the panel and deactivating await its in-flight write without killing or retrying it', async (t) => {
  const app = await fixture(t)
  const { panel, signal, finish } = await pendingMutation(app)
  panel.dispose()
  let stopped = false
  const stopping = app.deactivate().then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stopped, false)
  assert.equal(app.io.disposed, 0)
  assert.equal(signal.aborted, false)
  finish()
  await stopping
  assert.equal(app.io.disposed, 1)
  assert.equal(app.io.requests, 1)
})

test('a stale read response cannot abort or suppress a concurrent commit result', async (t) => {
  const app = await fixture(t)
  const { panel, signal, finish } = await pendingMutation(app)
  const commitHook = app.io.requestHook
  app.io.requestHook = (request) => request.url === '/api/commits?repository=old'
    ? { status: 409, body: { error: { code: 'REPOSITORY_CHANGED' } } }
    : commitHook(request)
  panel.receive({ type: 'palimpsest:request', id: 'old-read', method: 'GET', url: '/api/commits?repository=old' })
  await until(() => panel.webview.messages.some((message) => message.id === 'old-read'))
  assert.equal(signal.aborted, false)
  finish()
  await until(() => panel.webview.messages.some((message) => message.id === 'commit'))
  assert.equal(panel.webview.messages.find((message) => message.id === 'commit').status, 200)
  assert.equal(app.io.requests, 2)
})
