// Read+write support for the inline block renderer.
//
// The inline renderer (index.js, registerBlockRenderer) draws a real <table>.
// This module makes its cells `contentEditable` and writes edits back to the
// block with a debounced `logseq.Editor.updateBlock`, reusing the same
// table<->markdown conventions as the Slate modal editor (see utils/util.js).
//
// Two hazards are designed around here:
//
//  1. Caret jumps. Every updateBlock re-runs the block renderer. We never
//     re-sync cell text from props; React reconciles the identical serialized
//     text as a no-op, so the live contentEditable DOM (and caret) is left
//     untouched. We also ignore the echo of our own write.
//
//  2. Structural corruption. A literal `|` or stray `\r` typed into a cell
//     would break re-parsing (the parser splits naively on `|`). Cells are
//     read via innerText (so Enter-inserted <div>/<br> normalise to \n) and
//     sanitised: \r dropped, `|` neutralised, \n -> [:br] (the existing
//     newline token, matching slateValueToString).

const debounceTimers = new Map() // blockId -> timeout handle
const lastWritten = new Map()    // blockId -> last content we wrote (echo guard)

// Serialize one matrix (header row first, no delimiter row) to a markdown
// table. Mirrors slateValueToString in utils/util.js, including the
// "readable data" space-framed separator sizing, so an inline edit saves
// byte-identically to a modal save of the same table.
const serializeMatrix = (rows) => {
  const rowStrs = rows.map(cells => `|${cells.join('|')}|`)
  const sep = (rows[0] || []).map(s => {
    if (s.length >= 4 && s.startsWith(' ') && s.endsWith(' ')) {
      return ` ${'-'.repeat(s.length - 2)} `
    }
    return '--'
  }).join('|')
  rowStrs.splice(1, 0, `|${sep}|`)
  return rowStrs.join('\n')
}

const readCell = (el) => {
  // innerText collapses Enter-inserted block/<br> markup back to \n.
  return String(el.innerText ?? '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ') // nbsp -> space
    .replace(/\|/g, '│') // box-drawing bar: keep the table parseable
    .replace(/\n+$/g, '')     // contentEditable trailing newline
    .replace(/\n/g, '[:br]')
}

// Rebuild the whole block from the original segments, substituting each
// table segment with the current DOM state of its rendered table (in order).
const buildContent = (root, segments) => {
  const tables = root.querySelectorAll('table.lsp-mdt')
  let ti = 0
  return segments.map(seg => {
    if (seg.type !== 'table') return seg.str
    const tableEl = tables[ti++]
    if (!tableEl) return seg.str
    const rows = Array.from(tableEl.querySelectorAll('tr')).map(tr =>
      Array.from(tr.querySelectorAll('th,td')).map(readCell))
    return serializeMatrix(rows)
  }).join('\n')
}

const scheduleSave = (root, { segments, blockId, updateBlock, debounceMs }) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.set(blockId, setTimeout(() => {
    debounceTimers.delete(blockId)
    const content = buildContent(root, segments)
    if (lastWritten.get(blockId) === content) return // nothing changed
    lastWritten.set(blockId, content)
    Promise.resolve(updateBlock(blockId, content)).catch(err =>
      console.warn('[mdtable] inline edit save failed', err))
  }, debounceMs))
}

// Attach editing behaviour to a freshly-rendered renderer root. Idempotent:
// if Logseq reuses the DOM node across re-renders we don't double-bind.
export const attachInlineEditing = (root, opts) => {
  if (!root || root.dataset.lspInlineEdit === '1') return
  root.dataset.lspInlineEdit = '1'

  root.querySelectorAll('table.lsp-mdt th, table.lsp-mdt td').forEach(cell => {
    cell.setAttribute('contenteditable', 'true')
    cell.setAttribute('tabindex', '0')
    cell.spellcheck = false
  })

  // Capture phase: stop pointer/key events from reaching Logseq, which would
  // otherwise swap the block into its raw textarea and unmount this renderer.
  const swallow = (e) => {
    if (e.target.closest('table.lsp-mdt th, table.lsp-mdt td')) e.stopPropagation()
  }
  root.addEventListener('mousedown', swallow, true)
  root.addEventListener('click', swallow, true)
  root.addEventListener('keydown', swallow, true)
  root.addEventListener('dblclick', swallow, true)

  // Force plain-text paste so markup can't smuggle structure into a cell.
  root.addEventListener('paste', (e) => {
    const cell = e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault()
    e.stopPropagation()
    const text = (e.clipboardData || window.clipboardData).getData('text/plain')
    cell.ownerDocument.execCommand('insertText', false, text)
  })

  root.addEventListener('input', (e) => {
    if (!e.target.closest('table.lsp-mdt th, table.lsp-mdt td')) return
    scheduleSave(root, opts)
  })
}

// Called when the renderer for a block is torn down / re-created so a pending
// debounce doesn't fire against a stale DOM.
export const cancelInlineEditing = (blockId) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.delete(blockId)
}
