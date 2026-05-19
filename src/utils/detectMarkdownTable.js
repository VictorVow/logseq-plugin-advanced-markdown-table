// Pure, synchronous helpers for the inline block renderer.
// NOTE: parseMarkdownTable (parseRawInputByMarkdownIt) is unusable as a detector
// because it appends DEFAULT_TABLE and recurses when none is found, so it never
// reports "no table". This module provides a real synchronous detector instead.

// A GFM table delimiter row, e.g. |--|--| or | :--- | ---: | (with optional
// leading/trailing pipe and alignment colons).
const DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

// True when content contains a header row (a line with a pipe) immediately
// followed by a delimiter row. Cheap: `when` can be called frequently.
export const looksLikeMarkdownTable = (content) => {
  if (!content || typeof content !== 'string') return false
  const lines = content.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    const delim = lines[i + 1]
    if (lines[i].includes('|') && delim.includes('-') && DELIM_RE.test(delim)) {
      return true
    }
  }
  return false
}

// Convert a single markdown-table segment string into a 2D array of cell
// strings (header row first, delimiter row dropped). Mirrors the cell parsing
// in src/utils/util.js stringToSlateValue so the inline view matches the editor.
export const markdownTableToMatrix = (tableStr = '') => {
  const _arr = tableStr
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(_str => _str.replaceAll('[:br]', '\n'))
  const contentArr = [_arr[0]].concat(_arr.slice(2))
  return contentArr
    .filter(Boolean)
    .map(rowStr => {
      const rowArr = rowStr.trim().split('|')
      return rowArr.slice(1, rowArr.length - 1)
    })
}
