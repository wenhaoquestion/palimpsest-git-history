import { isLinuxHistorySite } from '../lib/site'
import { useEffect, useRef } from 'react'
import { isVSCode } from '../lib/host'
import { CloseIcon } from './icons'

interface HelpOverlayProps {
  open: boolean
  kind?: 'help' | 'setup'
  onClose: () => void
}

const shortcuts = [
  ['Space', 'Play or pause'],
  ['← / →', 'Previous or next commit'],
  ['Home', 'Return to the first commit'],
  ['F', 'Open filters'],
  ['I', 'Toggle inspection mode'],
  ['?', 'Open this guide'],
]

export function HelpOverlay({ open, kind = 'help', onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden)
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="overlay-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="help-overlay"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="help-title"
        aria-describedby="help-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button ref={closeRef} className="icon-button overlay-close" type="button" onClick={onClose} aria-label="Close guide">
          <CloseIcon />
        </button>
        {kind === 'setup' && !isLinuxHistorySite ? (
          <>
            <h2 id="help-title">Open any Git repository</h2>
            <p id="help-description">
              {isVSCode
                ? 'Choose Open in the header to select a repository with the VS Code folder picker.'
                : 'Choose Open in the header and enter the absolute path to a local Git repository.'}
              {' '}Switch projects at any time. For a remote project, clone it first,
              then select its folder.
            </p>
            <p className="help-note">
              Ordinary repositories, linked worktrees, and bare repositories are supported.
              Empty repositories become explorable after their first commit.
            </p>
          </>
        ) : (
          <>
            <h2 id="help-title">Navigate the archive</h2>
            <p id="help-description">
              {isLinuxHistorySite
                ? 'Explore the complete torvalds/linux Git history, from its 2005 import to the indexed tip. Commit history is complete; the landscape is a bounded sample. Open directories and changes for exact paged inspection.'
                : 'Replay a repository chronologically, select structures to inspect files, and follow the commit trace to understand branches and merges.'}
            </p>
            <div className="shortcut-list">
              {shortcuts.map(([key, label]) => (
                <div key={key}>
                  <kbd>{key}</kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <p className="help-note">
              Drag the surveyed field to pan. Scroll or pinch to zoom. Motion follows
              your system reduced-motion preference.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
