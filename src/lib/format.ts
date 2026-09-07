const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact' })

export function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date)
}

export function formatCompactNumber(value: number) {
  return compactNumber.format(value)
}

export function extensionFor(path: string) {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'no extension'
}

export function directoryFor(path: string) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? 'root' : path.slice(0, slash)
}
