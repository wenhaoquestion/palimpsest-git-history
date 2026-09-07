import { useEffect, useRef, useState } from 'react'
import { CloseIcon, FolderIcon } from './icons'

interface RepositoryPickerProps {
  open: boolean
  currentPath: string
  busy: boolean
  error: string | null
  onOpen: (path: string) => Promise<boolean>
  onClose: () => void
}

export function RepositoryPicker({ open, currentPath, busy, error, onOpen, onClose }: RepositoryPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState('')

  useEffect(() => {
    if (open) {
      setPath(currentPath)
      dialog.current?.showModal()
    } else {
      dialog.current?.close()
    }
  }, [currentPath, open])

  return (
    <dialog ref={dialog} className="repository-picker" aria-labelledby="repository-picker-title" onCancel={onClose}>
      <button className="icon-button overlay-close" type="button" aria-label="Close repository picker" onClick={onClose}>
        <CloseIcon />
      </button>
      <FolderIcon />
      <h2 id="repository-picker-title">Open a repository</h2>
      <p>Explore the history of any local Git project. Paste its folder path to begin.</p>
      <form onSubmit={async (event) => {
        event.preventDefault()
        if (!busy && path.trim() && await onOpen(path.trim())) onClose()
      }}>
        <label htmlFor="repository-path">Repository folder</label>
        <input id="repository-path" value={path} onChange={(event) => setPath(event.target.value)}
          placeholder="/Users/you/projects/my-project" required autoFocus autoComplete="off" spellCheck={false} disabled={busy} />
        <p className="repository-picker__hint">Use an absolute path on the computer running PALIMPSEST. Working trees and bare repositories are supported.</p>
        {error ? <p className="repository-picker__error" role="alert">{error}</p> : null}
        <button className="refresh-button" type="submit" disabled={busy || !path.trim()}>
          {busy ? 'Reading Git history…' : 'Open repository'}
        </button>
        {busy ? <p role="status" className="repository-picker__hint">The first scan of a large history may take a moment.</p> : null}
      </form>
    </dialog>
  )
}
