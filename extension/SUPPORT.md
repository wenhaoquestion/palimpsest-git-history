# Support

Report a problem or request a feature through [GitHub Issues](https://github.com/wenhaoquestion/palimpsest-git-history/issues). The [project repository](https://github.com/wenhaoquestion/palimpsest-git-history) contains the source and project documentation.

## Before reporting a problem

Run **Palimpsest: Refresh Git History** after changing commits or branches. If the view still looks stale, close it and run **Palimpsest: Open Git History** again.

For an opening error, confirm that:

- The workspace is trusted.
- `git --version` works in VS Code's integrated terminal on the workspace host.
- The selected folder is a Git repository or is inside one. Ordinary repositories, linked worktrees, and bare repositories are supported.
- In Remote SSH, WSL, or a Dev Container, Palimpsest is installed on that remote host and the repository exists there.

An empty repository becomes navigable after its first commit. A virtual workspace or a repository URL must first be made available as a filesystem checkout.

## Slow loading or a busy backend

The first request for a large history may spend time building its commit index. Rapid navigation cancels abandoned UI requests, and foreground reads take priority over queued prefetches. If a request times out, reopen the repository to retry.

Large landscapes use representative blocks. To inspect a specific directory or file, use the inspector and load additional paths instead of expecting every file to appear as an individual block.

The `palimpsest.workerMaxHeapMb` setting limits the worker's JavaScript heap. If the backend repeatedly exits because that limit is reached, raise it within the supported range of 128–2048 MB and reopen the view. This setting does not include Git subprocesses or native memory.

The `palimpsest.workerIdleSeconds` setting controls how long a hidden view retains its worker and caches. A shorter interval releases memory sooner; a longer interval can avoid rebuilding caches when switching editor tabs.

## Include in a bug report

- Palimpsest version and VS Code version.
- Operating system and whether the workspace is local, Remote SSH, WSL, or a Dev Container.
- Git version and approximate repository size or commit count.
- Steps to reproduce, the expected result, and the actual result.
- The visible error message, if any, and a small sample repository when possible.

For a blank or broken view, **Developer: Toggle Developer Tools** can show relevant webview errors. Extension-host errors are available through **Developer: Show Logs… → Extension Host**.
