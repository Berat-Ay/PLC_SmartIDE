export function escapeCsvCell(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value)
  if (/[",\r\n#%]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`
  }
  return raw
}

export function buildTraceCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(','))
  ].join('\n')
}
