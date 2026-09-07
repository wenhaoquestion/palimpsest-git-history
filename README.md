# PALIMPSEST

A Git history explorer for any filesystem repository, available as a VS Code extension and a standalone web app. Directories become districts, files become structures, and the timeline replays the history of the selected branch or all reachable refs. Git is read directly from disk; no account or cloud service is required.

## VS Code extension

Build the local installer:

```sh
npm install
npm run package:extension
```

In VS Code, run **Extensions: Install from VSIX…** and choose `releases/palimpsest-git-history-0.1.0.vsix`. Open your project, then run **Palimpsest: Open Git History**. Use **Palimpsest: Choose Repository…** or **Open** in the viewer to switch projects with a native folder picker. Use **Palimpsest: Refresh Git History** after new commits.

The installed extension requires VS Code 1.95+ and Git on the workspace host; it does not require a separate Node installation or web server. It runs Git in an isolated, lazily started worker with a bounded request queue. The worker is released 30 seconds after hiding the view and immediately after closing it. The selected repository, branch scope, and timeline position survive hiding and restoration. Packaged installers are available from [GitHub Releases](https://github.com/wenhaoquestion/palimpsest-git-history/releases).

Ordinary repositories, linked worktrees, bare repositories, and empty repositories are supported. The extension is configured to run on the workspace host in Remote SSH, WSL, and Dev Containers. Local macOS use has been tested in VS Code 1.136.1; Windows and remote hosts have not been exercised here. See [extension usage and settings](extension/README.md). The publisher identifier is `wenhaoquestion`; the Marketplace listing becomes available after publisher registration and publication.

## Linux history website

The separate [linux-history-website](linux-history-website/README.md) directory prepares and serves the full history available in the official `torvalds/linux` Git repository, without a shallow-history cutoff. It has its own data setup and deployment build, sharing this project's optimized renderer and Git service. Its public view is fixed to Linux and disables repository switching and administrative writes. The Linux repository data is downloaded separately and is not committed to this source repository.

The complete local mirror has been verified offline: 1,482,108 commits with all reachable file contents. Run the site on [localhost:4180](http://127.0.0.1:4180), or build an independent deployment using the directory's instructions. See [real Linux measurements and browser validation](linux-history-website/VALIDATION.md).

## Standalone web app

Requires Git and Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), choose **Open** in the header, and paste a local repository's absolute folder path. The repository name is also a shortcut to the picker. Switch projects without restarting the server. Normal checkouts, linked worktrees, bare repositories, and folders inside a checkout are supported. Empty repositories show an explanation until their first commit.

To inspect a remote project, clone it with Git first and open the resulting local folder. The viewer does not modify the selected repository. One server has one active repository shared across its browser tabs; reload another tab after switching projects.

An optional environment variable selects the initial repository:

```sh
PALIMPSEST_REPO=/absolute/path/to/repository npm run dev
```

PowerShell:

```powershell
$env:PALIMPSEST_REPO='E:\path\to\repository'
npm run dev
```

Without this variable, the server starts with its working directory. If that folder is not a repository, use **Open** to select one.

## Production

```sh
npm run build
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). `PALIMPSEST_REPO` also sets the initial production repository. The default bind address is loopback; `HOST` and `PORT` can override it. Keep the service local: it can read repositories available to the server process and has no user authentication.

## Controls

- **Open** or repository name: choose another local Git project.
- `Space`: play or pause; `←` / `→`: previous or next commit; `Home`: first commit.
- `F`: filters; `I`: overview/inspection; `?`: keyboard guide.
- Drag the landscape to pan; scroll or use `+` / `-` to zoom.
- Drag the timeline to preview an index and estimated date; release to load that commit. Escape or pointer cancellation discards the preview. Keyboard navigation on the slider is also supported.
- Select a file, directory, commit, branch, or tag to inspect it. Diff, exact change statistics, directory entries, and file history load on demand.

Playback waits for the selected snapshot before advancing. Metadata filters cover the complete history of small repositories; for paged histories they highlight matches in the loaded window, as stated in the filter panel. Branch selection covers the entire history.

## Performance and data flow

Git commands use argument arrays with no shell interpolation. Commit IDs are streamed into a temporary fixed-width disk index, allowing direct page reads without loading every commit into JavaScript memory. Pages contain 128 commits (up to 512 through the API).

The browser requests metadata-only pages (`stats=false`), so seeking does not calculate textual diffs for 128 commits. Exact statistics remain available through commit/change inspection. A landscape includes exact repository counts, at most 256 directory summaries at depth 0–2, 720 representative files, and 384 changed paths. Counts in retained directory summaries are exact; `directorySummary` reports their coverage. Full trees and changes are paginated on demand. File sizes cover the sampled files.

During timeline dragging there are no destination requests. Preview updates are coalesced to animation frames, and releasing the slider performs one seek. Request caches share in-flight reads, abort transport when their last consumer leaves, bound concurrency, and reserve capacity for foreground reads. Only two neighbors are prefetched. The previous landscape stays visible while the destination loads; selecting an existing structure does not rebuild its layout, and drawing skips structures outside the viewport.

Opening a repository validates the candidate before replacing the active one. Failed opens retain the previous project. A repository session ID isolates browser caching and rejects stale requests. Switching releases the previous service's indexes after its active requests finish.

Frontend caches have a combined 48 MiB estimated budget; all caches in a Git service share another 48 MiB estimated budget. Oversized entries are not retained. Git work is limited to four concurrent processes and 64 queued commands; stdout reserves at most 96 MiB including its consolidation copy. Oversized exact output returns an explicit error. Estimates bound retained cache data, not the entire process heap or RSS. The extension worker defaults to a 384 MiB JavaScript heap limit and uses structured IPC without repeated JSON serialization. Git subprocesses, native buffers, VS Code, and its webview consume additional memory.

Change/statistic matching uses indexed lookups instead of repeated array scans. NUL-separated Git output is decoded record by record, so a small retained path does not keep a large decoded output string alive. Landscape samples and directory summaries use bounded selection; exact directory pagination constructs only the requested page and reads blob sizes only for that page. Unused full-history graph construction and duplicated request management were removed.

Measured on macOS ARM64 / Node 20 with a synthetic repository of 1,200 commits and 20,000 files (128 edited files per later commit, 500 lines per file):

| Operation | Before | After |
| --- | ---: | ---: |
| Initial repository response | 1,524 ms | 139 ms |
| Uncached 128-commit page | 895–903 ms | 13.8–14.6 ms |
| Landscape snapshot | 63–82 ms | 69–89 ms |

A separate memory fixture has 12 commits and 50,000 long-path files, all modified in every commit. Both versions read 12 exact change sets, six exact snapshots, and perform 60 deterministic seeks. Both run against the same prebuilt fixture with `--expose-gc`; heap samples follow forced collection.

| Backend memory | Before | After |
| --- | ---: | ---: |
| Peak process RSS | 537 MiB | 276.5 MiB |
| Heap after 12 exact change sets | 137.3 MiB | 20.3 MiB |
| Heap after 60 seeks | 240.9 MiB | 9.8 MiB |

The complete memory workload takes 8.3 seconds before and 9.3 seconds after; conservative cache accounting trades some throughput for substantially lower retained memory. RSS covers the measured backend process, excluding Git subprocesses, VS Code, and the webview. Disposing the optimized service leaves no cached entries, queued Git commands, or active Git processes.

In a Chromium test, a 60-point drag triggered zero API reads while held and one destination history-page read after release; the snapshot settled in 234 ms, with no observed long tasks. In the actual VS Code webview, a 50-point drag had an 8.4 ms frame-interval p95 on the test display and loaded destination metadata 401 ms after release. Hiding and restoring the panel preserved its selected commit.

The complete Linux repository was also measured offline: indexing 1,482,108 commits took 18.06 seconds, random 128-commit pages took 29.9–31.4 ms, and landscapes took 390–869 ms. After this workload and garbage collection, the measured Node backend retained 13.7 MiB of heap and 125.3 MiB RSS, excluding Git subprocesses. The installed extension also opened this full repository in the user's local VS Code and navigated to its final commit.

These are local measurements, not a claim about every repository or display. Initial indexing depends on Git graph traversal and disk speed. C++ was not added: removing unnecessary diff computation and retained buffers addressed the measured bottlenecks, while Git already performs repository operations natively.

## Validation and benchmarks

```sh
npm run check
npm test
npm run build
npm run benchmark
npm run benchmark:memory
npm run package:extension
```

The benchmark creates and removes its own synthetic repository. Use `npm run benchmark -- --repo /path/to/repository` to measure an existing repository. Add `--stats` to measure the full-statistics path, or `--module /path/to/older/git-service.mjs` to compare a saved implementation.

The memory benchmark also accepts `--repo` and `--module`. First run `npm run benchmark:memory -- --keep` to retain a generated fixture; use the printed repository path for both comparison runs. This avoids including fixture construction in peak-RSS comparisons. Without `--keep`, generated repositories are removed automatically; supplied repositories are never removed.

Tests use real temporary repositories to cover ordering, branches, merges, tags, binary/Unicode paths, renames, exact and sampled trees, diffs, worktrees, bare repositories, cache refresh, repository switching, stale requests, cancellation, foreground scheduling, bounded caches, worker crashes/timeouts, process cleanup, and extension lifecycle. Browser checks additionally cover rapid seeks, playback, keyboard and pointer cancellation, repository switching, narrow layouts, and resizing the landscape.

## Code map

- `src/App.tsx`: repository workspace, playback, and inspection coordination.
- `src/components/RepositoryPicker.tsx`: local repository selection.
- `src/components/RepositoryCanvas.tsx` / `src/lib/repository-layout.ts`: Canvas rendering and bounded spatial layout.
- `src/lib/request-cache.ts`: shared request scheduling and LRU storage.
- `src/lib/host.ts`: webview message transport and minimal persisted UI state.
- `src/hooks/useCommitTimeline.ts` / `useCommitResource.ts`: paged metadata and lazy snapshots/inspection.
- `server/git-service.mjs`: Git extraction, validation, indexing, and caching.
- `server/api-middleware.mjs`: development/production API and active repository sessions.
- `server/rpc-client.mjs` / `rpc-worker.mjs`: isolated, cancellable VS Code backend transport.
- `extension/extension.cjs`: VS Code commands, workspace discovery, webview, and worker lifecycle.
