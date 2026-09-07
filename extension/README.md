# Palimpsest — Git History

See how your repository took shape. Palimpsest turns Git history into an interactive landscape of directories and files, right inside VS Code.

![Palimpsest in VS Code, showing a commit timeline, repository landscape, and changed-file inspector](media/history-vscode.png)

*An example repository with 1,200 commits. The screenshot uses generated test data.*

## Explore history visually

- **Scrub through commits.** Preview a position as you drag, then release to load that commit. Play history forward or step through it with the keyboard.
- **See what changed.** Directories form districts; file blocks highlight additions, edits, deletions, and renames. Pan and zoom to explore the scene.
- **Inspect the details.** Select a file to read its diff or history, browse a directory, and load more changed paths when needed.
- **Follow branches and merges.** Change the branch scope and navigate the commit rail alongside the landscape.
- **Move between projects.** Choose repositories with VS Code's native picker, including ordinary repositories, linked worktrees, and bare repositories.

## Install and open

Search for **Palimpsest — Git History** by **wenhao_question** in VS Code's Extensions view. Packaged `.vsix` builds are also available from [GitHub Releases](https://github.com/wenhaoquestion/palimpsest-git-history/releases); install them with **Extensions: Install from VSIX…**.

Or install the Marketplace extension with:

```sh
code --install-extension wenhaoquestion.palimpsest-git-history
```

After installation:

1. Open a trusted workspace containing a Git repository.
2. Run **Palimpsest: Open Git History** from the Command Palette.
3. Drag the timeline, select a commit, or press **Play**.

A single workspace repository opens automatically. When multiple repositories are found, choose one from the picker. To open another project, run **Palimpsest: Choose Repository…** or right-click a folder in Explorer.

## Commands and controls

| Command | Action |
| --- | --- |
| **Palimpsest: Open Git History** | Open or reveal the history view. |
| **Palimpsest: Choose Repository…** | Select a workspace repository or browse for another folder. |
| **Palimpsest: Refresh Git History** | Reload after commits or branches change. |

With the history view focused, **Space** plays or pauses, **← / →** steps between commits, and **Home** returns to the beginning. Press **F** for filters, **I** for inspection mode, or **?** for help. Drag the landscape to pan and scroll to zoom; when the canvas itself is focused, its arrow keys pan the view.

## Built for large repositories

History summaries and file listings load in pages. The landscape uses representative file blocks and directory totals to keep large trees readable; exact paths and diffs remain available through the inspector. Initial indexing of a large history can take longer than later navigation.

Git runs in an isolated worker. Hiding the view pauses playback and cancels pending UI requests; the worker and its caches are released after an idle interval. Reopening restores the selected repository, branch scope, and commit position.

| Setting | Default | What it controls |
| --- | ---: | --- |
| `palimpsest.workerIdleSeconds` | `30` | How long a hidden view keeps its worker. Use `0` to release it immediately. |
| `palimpsest.workerMaxHeapMb` | `384` | Worker JavaScript heap limit, applied at the next start. Git subprocesses and native memory are additional. |

For large histories, metadata filters apply to the loaded commit window; branch selection covers the selected branch's complete history. File filters affect the current snapshot.

## Requirements

- **VS Code 1.95 or later** and **Git** installed on the workspace host.
- A **trusted filesystem workspace**. Virtual workspaces are not supported.
- An existing repository. Clone a remote repository before opening its folder.

For Remote SSH, WSL, or Dev Containers, install Palimpsest on the remote workspace host. Repository reads run there, with the visualization displayed in your VS Code editor. No Palimpsest account or cloud service is required.

See [troubleshooting and support](SUPPORT.md), the [release notes](CHANGELOG.md), or the [project on GitHub](https://github.com/wenhaoquestion/palimpsest-git-history).
