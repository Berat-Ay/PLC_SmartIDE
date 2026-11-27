export type InlineMarkdownToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }

/**
 * Splits a single line of text into ordered plain, bold (**...**), and inline-code (`...`) tokens.
 */
export function parseInlineMarkdownTokens(str: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = []
  let remaining = str

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*(.*)$/)
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)$/)

    if (boldMatch && (!codeMatch || boldMatch[1].length <= codeMatch[1].length)) {
      if (boldMatch[1]) tokens.push({ type: 'text', value: boldMatch[1] })
      tokens.push({ type: 'bold', value: boldMatch[2] })
      remaining = boldMatch[3]
    } else if (codeMatch) {
      if (codeMatch[1]) tokens.push({ type: 'text', value: codeMatch[1] })
      tokens.push({ type: 'code', value: codeMatch[2] })
      remaining = codeMatch[3]
    } else {
      tokens.push({ type: 'text', value: remaining })
      break
    }
  }

  return tokens
}
