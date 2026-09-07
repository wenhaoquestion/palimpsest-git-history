# Changelog

## 0.1.0

Initial release.

- Added an interactive repository landscape, chronological commit rail, timeline scrubbing, and playback.
- Added file diffs, file history, directory browsing, and paged changed-file inspection.
- Added branch selection, metadata filters for the loaded history window, and file filters for the current snapshot.
- Added native VS Code repository selection for workspace folders, ordinary repositories, linked worktrees, and bare repositories.
- Added support for workspace extension hosts, including Remote SSH, WSL, and Dev Containers.
- Kept timeline drag previews local, with a single seek on release and recovery when an editor overlay consumes the mouse release.
- Added bounded requests, foreground priority, cancellation, and an isolated Git worker with a configurable heap limit.
- Added worker cleanup for hidden and closed views, plus restoration of repository, branch scope, and commit position.
- Restricted packaged resources with a Content Security Policy and disabled Git execution in untrusted or virtual workspaces.
