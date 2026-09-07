import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Accessible title. Icons are hidden from assistive technology when omitted. */
  title?: string
  /** Optical square size. Defaults to `1em` so icons follow surrounding type. */
  size?: number | string
}

interface IconFrameProps extends IconProps {
  children: ReactNode
  fillIcon?: boolean
}

function IconFrame({
  children,
  title,
  size = '1em',
  fillIcon = false,
  ...props
}: IconFrameProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fillIcon ? 'currentColor' : 'none'}
      stroke={fillIcon ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <IconFrame {...props} fillIcon>
      <path d="M7.25 4.92a1.15 1.15 0 0 1 1.77-.97l10.18 7.08a1.18 1.18 0 0 1 0 1.94L9.02 20.05a1.15 1.15 0 0 1-1.77-.97V4.92Z" />
    </IconFrame>
  )
}

export function PauseIcon(props: IconProps) {
  return (
    <IconFrame {...props} fillIcon>
      <rect x="6" y="4" width="4.25" height="16" rx="1" />
      <rect x="13.75" y="4" width="4.25" height="16" rx="1" />
    </IconFrame>
  )
}

export function RestartIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.15 8.1A8.75 8.75 0 1 1 3.5 14" />
      <path d="M4.15 3.9v4.2h4.2" />
    </IconFrame>
  )
}

export function PreviousIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M6.25 5v14" />
      <path d="m18.2 5.45-8.5 6.1a.55.55 0 0 0 0 .9l8.5 6.1V5.45Z" fill="currentColor" stroke="none" />
    </IconFrame>
  )
}

export function NextIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M17.75 5v14" />
      <path d="m5.8 5.45 8.5 6.1a.55.55 0 0 1 0 .9l-8.5 6.1V5.45Z" fill="currentColor" stroke="none" />
    </IconFrame>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m14.75 5.5-6.5 6.5 6.5 6.5" />
    </IconFrame>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m9.25 5.5 6.5 6.5-6.5 6.5" />
    </IconFrame>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m5.5 9 6.5 6 6.5-6" />
    </IconFrame>
  )
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m5.5 15 6.5-6 6.5 6" />
    </IconFrame>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" />
    </IconFrame>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="10.75" cy="10.75" r="6.5" />
      <path d="m15.65 15.65 4.1 4.1" />
    </IconFrame>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M3.75 5.25h16.5l-6.5 7.15v5.75l-3.5 1.6V12.4l-6.5-7.15Z" />
    </IconFrame>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="6.25" cy="5.25" r="2" />
      <circle cx="17.75" cy="7.25" r="2" />
      <circle cx="6.25" cy="18.75" r="2" />
      <path d="M6.25 7.25v9.5M8.25 14.25c4.95 0 4-7 7.5-7" />
    </IconFrame>
  )
}

export function MergeIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v2.1c0 5.5 6 3.15 6 7.9M18 7v2.1c0 5.5-6 3.15-6 7.9" />
    </IconFrame>
  )
}

export function TagIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M20 13.1 12.9 20.2a1.8 1.8 0 0 1-2.55 0L3.8 13.65a1.8 1.8 0 0 1-.53-1.27V5.05c0-1 .8-1.8 1.8-1.8h7.33c.48 0 .94.19 1.28.53L20 10.55a1.8 1.8 0 0 1 0 2.55Z" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    </IconFrame>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
    </IconFrame>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m4.75 12.25 4.5 4.5 10-10" />
    </IconFrame>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M6.25 2.75h7l4.5 4.5v14h-11.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z" />
      <path d="M13.25 2.75v4.5h4.5M8 12h6.25M8 15.5h6.25" />
    </IconFrame>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M3.25 7.25h17.5v11.5a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V7.25Z" />
      <path d="M3.25 7.25V5.5a2 2 0 0 1 2-2h4.2l2 2.25h7.3a2 2 0 0 1 2 1.5" />
    </IconFrame>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.5l3.75 2" />
    </IconFrame>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3.25" y="5.25" width="17.5" height="15.5" rx="2" />
      <path d="M7.5 3v4.25M16.5 3v4.25M3.25 9.5h17.5" />
    </IconFrame>
  )
}

export function CommitIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M3 12h5M16 12h5" />
      <circle cx="12" cy="12" r="4" />
    </IconFrame>
  )
}

export function CodeIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m8.25 5.5-6 6.5 6 6.5M15.75 5.5l6 6.5-6 6.5M14 3.75l-4 16.5" />
    </IconFrame>
  )
}

export function HistoryIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.35 8.1A8.75 8.75 0 1 1 3.5 14" />
      <path d="M4.35 3.9v4.2h4.2M12 7.25V12l3.25 2" />
    </IconFrame>
  )
}

export function UserIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </IconFrame>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </IconFrame>
  )
}

export function ExpandIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M14.5 4H20v5.5M20 4l-6.5 6.5M9.5 20H4v-5.5M4 20l6.5-6.5" />
    </IconFrame>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <IconFrame {...props} fillIcon>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </IconFrame>
  )
}

export function OverviewIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m12 2.75 8.25 4.55v9.4L12 21.25 3.75 16.7V7.3L12 2.75Z" />
      <path d="m3.95 7.4 8.05 4.5 8.05-4.5M12 11.9v9.1" />
    </IconFrame>
  )
}

export function InspectIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5 5.25h14M5 12h14M5 18.75h9" />
      <circle cx="3" cy="5.25" r=".75" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r=".75" fill="currentColor" stroke="none" />
      <circle cx="3" cy="18.75" r=".75" fill="currentColor" stroke="none" />
    </IconFrame>
  )
}

export function HelpIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9.15a2.55 2.55 0 1 1 3.36 2.42c-.67.3-1.06.76-1.06 1.43v.35" />
      <circle cx="12" cy="17.25" r=".85" fill="currentColor" stroke="none" />
    </IconFrame>
  )
}

export function RepoIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5.25 3.25h13.5a1.5 1.5 0 0 1 1.5 1.5v12.5a1.5 1.5 0 0 1-1.5 1.5H8l-4.25 2v-16a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M8 7.25h8M8 11h8M8 14.75h5" />
    </IconFrame>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M19.7 8.25A8.5 8.5 0 0 0 4.55 6.7L3.5 8.25" />
      <path d="M3.5 4.25v4h4" />
      <path d="M4.3 15.75A8.5 8.5 0 0 0 19.45 17.3l1.05-1.55" />
      <path d="M20.5 19.75v-4h-4" />
    </IconFrame>
  )
}
