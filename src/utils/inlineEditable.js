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
//     newline token).

const debounceTimers = new Map() // blockId -> timeout handle
const lastWritten = new Map()    // blockId -> last content we wrote (echo guard)
// blockId -> {ord,rowIdx,colIdx}: re-anchor the pinned toolbar to this
// position after a toolbar action causes the block to re-render.
const pendingToolbar = new Map()

// --- Width fitting -------------------------------------------------------
//
// The renderer sits inside Logseq core markup we don't control. A wide
// (max-content) table will, through a flex/grid ancestor that lacks
// min-width:0, stretch the whole block past the viewport: the last column
// is clipped and Logseq's top-right "Switch to outline view" button is
// pushed off-screen. CSS alone can't fix this without styling that unknown
// ancestor, so we measure the real clipping ancestor and pin the scroll
// box to a pixel width — the table then scrolls inside its own box.

const isScrollContainer = (cs) =>
  /(auto|scroll|hidden)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY)

const findClipAncestor = (el) => {
  const doc = el.ownerDocument
  const win = doc.defaultView || window
  let p = el.parentElement
  while (p && p !== doc.body && p !== doc.documentElement) {
    if (isScrollContainer(win.getComputedStyle(p))) return p
    p = p.parentElement
  }
  return doc.scrollingElement || doc.documentElement
}

// Pin every .lsp-mdtable-scroll in `root` to the width actually available
// at its position inside the clipping ancestor. Synchronous: collapse,
// measure, restore — no paint happens between, so there is no flash.
// Trailing scroll space (px) so a wide table can be scrolled far enough
// that its last column clears Logseq's top-right "Switch to outline view"
// button (which floats over the renderer's right edge).
const BUTTON_CLEARANCE = 52

export const fitInlineTableWidth = (root) => {
  if (!root || !root.isConnected) return
  const scrolls = root.querySelectorAll('.lsp-mdtable-scroll')
  if (!scrolls.length) return
  scrolls.forEach(s => {
    s.style.maxWidth = '0px'      // reflow to natural layout
    s.style.paddingRight = ''     // measure true overflow without our spacer
  })
  // When maximised the renderer itself defines the available width; the
  // Logseq block clip ancestor is irrelevant. Let the scroll wrapper fill
  // the window so the table can render edge-to-edge.
  if (root.classList.contains('lsp-mdt-max')) {
    scrolls.forEach(s => {
      s.style.maxWidth = '100%'
      if (s.scrollWidth > s.clientWidth + 1) {
        s.style.paddingRight = BUTTON_CLEARANCE + 'px'
      }
    })
    return
  }
  const clip = findClipAncestor(root)
  const clipRect = clip.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  const leftGap = Math.max(0, Math.round(rootRect.left - clipRect.left))
  const avail = Math.floor(clip.clientWidth - leftGap - 8) // gutter for safety
  scrolls.forEach(s => {
    s.style.maxWidth = avail > 120 ? avail + 'px' : '100%'
    // Only when the table is actually wider than its box: reserve end
    // padding so the user can scroll the last column past the button.
    // (Chromium includes a scroll container's end padding in scroll range.)
    if (s.scrollWidth > s.clientWidth + 1) {
      s.style.paddingRight = BUTTON_CLEARANCE + 'px'
    }
  })
}

// Refit on viewport changes. One debounced resize listener per document;
// it refits every rendered table so column widths track the window.
const resizeBoundDocs = new WeakSet()
const bindResizeRefit = (root) => {
  const doc = root.ownerDocument
  const win = doc.defaultView || window
  if (resizeBoundDocs.has(doc)) return
  resizeBoundDocs.add(doc)
  let t
  const refitAll = () => {
    clearTimeout(t)
    t = setTimeout(() => {
      doc.querySelectorAll('.lsp-mdtable-renderer').forEach(fitInlineTableWidth)
    }, 100)
  }
  win.addEventListener('resize', refitAll)
}

// Called from the renderer's ref on every (re-)mount, regardless of whether
// in-place editing is enabled — the overflow exists in read-only mode too.
export const prepareInlineRenderer = (root) => {
  if (!root) return
  // Re-renders (e.g. after a structural op) create a fresh renderer DOM.
  // If a previous renderer for this block was maximised, its reparented
  // node is now orphaned under <body>. Remove it so orphans don't pile up.
  const blockId = root.getAttribute('data-blockid')
  const doc = root.ownerDocument
  if (blockId) {
    doc.querySelectorAll('.lsp-mdtable-renderer.lsp-mdt-max').forEach(stale => {
      if (stale === root) return
      if (stale.getAttribute('data-blockid') !== blockId) return
      const ph = stale.__mdtMaxPlaceholder
      if (ph && ph.parentNode) ph.remove()
      stale.remove()
    })
  }
  fitInlineTableWidth(root)
  // The ref can fire before Logseq has placed the element / laid out its
  // ancestors; remeasure after the next frame once layout has settled.
  const win = root.ownerDocument.defaultView || window
  win.requestAnimationFrame(() => fitInlineTableWidth(root))
  bindResizeRefit(root)
}

// Serialize one matrix (header row first, no delimiter row) to a markdown
// table. Emits the "readable data" space-framed separator sizing.
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

// Current DOM state of one rendered table as a matrix (header row first).
const readTableMatrix = (tableEl) =>
  Array.from(tableEl.querySelectorAll('tr')).map(tr =>
    Array.from(tr.querySelectorAll('th,td')).map(readCell))

// Rebuild the whole block from the original segments, substituting each
// table segment with the current DOM state of its rendered table (in order).
// `transform(matrix, tableOrdinal)` may return a modified matrix to apply a
// structural change to one specific table.
const buildContent = (root, segments, transform) => {
  const tables = root.querySelectorAll('table.lsp-mdt')
  let ti = 0
  return segments.map(seg => {
    if (seg.type !== 'table') return seg.str
    const ord = ti
    const tableEl = tables[ti++]
    if (!tableEl) return seg.str
    let rows = readTableMatrix(tableEl)
    if (transform) rows = transform(rows, ord)
    return serializeMatrix(rows)
  }).join('\n')
}

// Move focus to a cell and place the caret at the end of its text.
const caretToEnd = (el) => {
  el.focus()
  const doc = el.ownerDocument
  const sel = (doc.defaultView || window).getSelection && (doc.defaultView || window).getSelection()
  if (!sel) return
  const range = doc.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

// Move the caret to a neighbouring cell of the currently focused markdown-
// table cell. `direction` ∈ 'up' | 'down' | 'left' | 'right'. No-op if
// focus isn't in a cell, or at the table edge. Invoked from Logseq
// command-shortcut callbacks so the keybinding is editable in the host's
// keymap.
export const moveCaretInFocusedTableCell = (direction) => {
  let hostDoc = null
  try { hostDoc = (window.top || window.parent)?.document } catch (_) { /* cross-origin */ }
  if (!hostDoc) return
  const active = hostDoc.activeElement
  const cell = active && active.closest && active.closest('table.lsp-mdt th, table.lsp-mdt td')
  if (!cell) return
  const table = cell.closest('table.lsp-mdt')
  const tr = cell.closest('tr')
  const rows = Array.from(table.querySelectorAll('tr'))
  const cells = Array.from(tr.querySelectorAll('th,td'))
  const colIdx = cells.indexOf(cell)
  let next = null
  if (direction === 'up' || direction === 'down') {
    const target = rows[rows.indexOf(tr) + (direction === 'up' ? -1 : 1)]
    next = target && target.querySelectorAll('th,td')[colIdx]
  } else if (direction === 'left' || direction === 'right') {
    next = cells[colIdx + (direction === 'left' ? -1 : 1)]
  }
  if (next) caretToEnd(next)
}

// Insert a row/column relative to the currently focused markdown-table
// cell. `which` ∈ 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight'.
// No-op if focus isn't in a cell, or if the op is invalid at this edge
// (e.g. inserting a row above the header row).
export const insertInFocusedTableCell = (which) => {
  let hostDoc = null
  try { hostDoc = (window.top || window.parent)?.document } catch (_) { /* cross-origin */ }
  if (!hostDoc) return
  const active = hostDoc.activeElement
  const cell = active && active.closest && active.closest('table.lsp-mdt th, table.lsp-mdt td')
  if (!cell) return
  const root = cell.closest('.lsp-mdtable-renderer')
  const opts = root && root._lspInlineOpts
  if (!opts) return
  doInsertOp(root, opts, cell, which)
}

// Move the focused cell's row/column. `which` ∈ 'rowUp' | 'rowDown' |
// 'colLeft' | 'colRight'. No-op if focus isn't in a cell or the op is
// invalid at this edge (e.g. moving the first body row up would swap it
// with the header).
export const moveInFocusedTableCell = (which) => {
  let hostDoc = null
  try { hostDoc = (window.top || window.parent)?.document } catch (_) { /* cross-origin */ }
  if (!hostDoc) return
  const active = hostDoc.activeElement
  const cell = active && active.closest && active.closest('table.lsp-mdt th, table.lsp-mdt td')
  if (!cell) return
  const root = cell.closest('.lsp-mdtable-renderer')
  const opts = root && root._lspInlineOpts
  if (!opts) return
  doMoveOp(root, opts, cell, which)
}

// Delete the focused cell's row/column. `which` ∈ 'row' | 'col'. No-op
// if focus isn't in a cell, if the row is the header (we need it to keep
// the table valid markdown), or if the table only has one row/column left.
export const deleteInFocusedTableCell = (which) => {
  let hostDoc = null
  try { hostDoc = (window.top || window.parent)?.document } catch (_) { /* cross-origin */ }
  if (!hostDoc) return
  const active = hostDoc.activeElement
  const cell = active && active.closest && active.closest('table.lsp-mdt th, table.lsp-mdt td')
  if (!cell) return
  const root = cell.closest('.lsp-mdtable-renderer')
  const opts = root && root._lspInlineOpts
  if (!opts) return
  const tableEl = cell.closest('table.lsp-mdt')
  const tr = cell.closest('tr')
  const rows = Array.from(tableEl.querySelectorAll('tr'))
  const rowIdx = rows.indexOf(tr)
  const cells = Array.from(tr.querySelectorAll('th,td'))
  const colIdx = cells.indexOf(cell)
  const ord = Array.from(root.querySelectorAll('table.lsp-mdt')).indexOf(tableEl)
  let op, newRow = rowIdx, newCol = colIdx
  if (which === 'row') {
    if (rowIdx < 1 || rows.length < 2) return // protect header / last row
    op = tableOps.deleteRow
    if (newRow >= rows.length - 1) newRow = rows.length - 2
  } else if (which === 'col') {
    if (cells.length < 2) return
    op = tableOps.deleteCol
    if (newCol >= cells.length - 1) newCol = cells.length - 2
  } else return
  pendingToolbar.set(opts.blockId, { ord, rowIdx: newRow, colIdx: newCol })
  commitStructural(root, opts, (m, i) => (i === ord ? op(m, rowIdx, colIdx) : m))
}

// Shared by the local Alt+Shift+Arrow handler and the registered move
// commands. Stashes a `pendingToolbar` entry at the moved cell's new
// position so `resumePinnedToolbar` follows the cell after re-render.
const doMoveOp = (root, opts, cell, which) => {
  const tableEl = cell.closest('table.lsp-mdt')
  const tr = cell.closest('tr')
  const rows = Array.from(tableEl.querySelectorAll('tr'))
  const rowIdx = rows.indexOf(tr)
  const cells = Array.from(tr.querySelectorAll('th,td'))
  const colIdx = cells.indexOf(cell)
  const ord = Array.from(root.querySelectorAll('table.lsp-mdt')).indexOf(tableEl)
  let op, newRow = rowIdx, newCol = colIdx
  if (which === 'rowUp') {
    if (rowIdx < 2) return // can't swap a body row over the header
    op = tableOps.moveRowUp; newRow = rowIdx - 1
  } else if (which === 'rowDown') {
    if (rowIdx < 1 || rowIdx >= rows.length - 1) return
    op = tableOps.moveRowDown; newRow = rowIdx + 1
  } else if (which === 'colLeft') {
    if (colIdx < 1) return
    op = tableOps.moveColLeft; newCol = colIdx - 1
  } else if (which === 'colRight') {
    if (colIdx >= cells.length - 1) return
    op = tableOps.moveColRight; newCol = colIdx + 1
  } else return
  pendingToolbar.set(opts.blockId, { ord, rowIdx: newRow, colIdx: newCol })
  commitStructural(root, opts, (m, i) => (i === ord ? op(m, rowIdx, colIdx) : m))
}

// Shared by the local Alt+Ctrl+Shift+Arrow handler and the registered insert
// commands. Stashes a `pendingToolbar` entry at the new cell's position
// so `resumePinnedToolbar` refocuses it after the re-render (and re-pins
// the toolbar if the user has it pinned).
const doInsertOp = (root, opts, cell, which) => {
  const tableEl = cell.closest('table.lsp-mdt')
  const tr = cell.closest('tr')
  const rowIdx = Array.from(tableEl.querySelectorAll('tr')).indexOf(tr)
  const colIdx = Array.from(tr.querySelectorAll('th,td')).indexOf(cell)
  const ord = Array.from(root.querySelectorAll('table.lsp-mdt')).indexOf(tableEl)
  let op, newRow = rowIdx, newCol = colIdx
  if (which === 'rowAbove') {
    if (rowIdx < 1) return // header row has no "above"
    op = tableOps.insertRowAbove; newRow = rowIdx
  } else if (which === 'rowBelow') {
    op = tableOps.insertRowBelow; newRow = rowIdx + 1
  } else if (which === 'colLeft') {
    op = tableOps.insertColLeft; newCol = colIdx
  } else if (which === 'colRight') {
    op = tableOps.insertColRight; newCol = colIdx + 1
  } else return
  pendingToolbar.set(opts.blockId, { ord, rowIdx: newRow, colIdx: newCol })
  commitStructural(root, opts, (m, i) => (i === ord ? op(m, rowIdx, colIdx) : m))
}

const writeContent = (blockId, content, updateBlock) => {
  if (lastWritten.get(blockId) === content) return // nothing changed
  lastWritten.set(blockId, content)
  Promise.resolve(updateBlock(blockId, content)).catch(err =>
    console.warn('[mdtable] inline table save failed', err))
}

const scheduleSave = (root, { segments, blockId, updateBlock, debounceMs }) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.set(blockId, setTimeout(() => {
    debounceTimers.delete(blockId)
    writeContent(blockId, buildContent(root, segments), updateBlock)
  }, debounceMs))
}

// Apply a structural change immediately (no debounce). Any pending
// keystroke save is folded in first (it reads the same live DOM).
const commitStructural = (root, { segments, blockId, updateBlock }, transform) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.delete(blockId)
  writeContent(blockId, buildContent(root, segments, transform), updateBlock)
}

// --- Right-click menu ----------------------------------------------------
//
// Logseq has no per-cell context-menu API; the block renderer gives us the
// DOM, so we build our own. Structural ops below operate on the matrix and
// are written through the same serialize/updateBlock path as edits, so an
// inline structural change round-trips identically to a modal one.

const padRectangular = (m) => {
  const w = Math.max(1, ...m.map(r => r.length))
  return m.map(r => r.concat(Array(Math.max(0, w - r.length)).fill('')))
}
const newRow = (w) => Array(Math.max(1, w)).fill('')

// Numeric when both sides parse as finite numbers; otherwise locale
// text. Used by the sort ops; blank handling is done by the caller.
const cmpVal = (a, b) => {
  const as = String(a).trim(), bs = String(b).trim()
  const an = Number(as), bn = Number(bs)
  if (as !== '' && bs !== '' && Number.isFinite(an) && Number.isFinite(bn) && an !== bn)
    return an - bn
  return as.localeCompare(bs)
}

// Stable sort of body rows (header row 0 fixed) by column c.
// dir = 1 ascending, -1 descending. Blank cells always sort last.
const sortBody = (m, c, dir) => {
  if (m.length < 3) return m
  const idx = m.slice(1).map((row, i) => [row, i])
  idx.sort(([p, pi], [q, qi]) => {
    const pe = String(p[c] ?? '').trim() === ''
    const qe = String(q[c] ?? '').trim() === ''
    if (pe && qe) return pi - qi
    if (pe) return 1
    if (qe) return -1
    const r = dir * cmpVal(p[c] ?? '', q[c] ?? '')
    return r !== 0 ? r : pi - qi          // stable
  })
  return [m[0], ...idx.map(([row]) => row)]
}

const tableOps = {
  insertRowAbove: (m, r) => { const x = padRectangular(m); x.splice(r, 0, newRow(x[0].length)); return x },
  insertRowBelow: (m, r) => { const x = padRectangular(m); x.splice(r + 1, 0, newRow(x[0].length)); return x },
  deleteRow:      (m, r) => { const x = m.slice(); x.splice(r, 1); return x },
  insertColLeft:  (m, _r, c) => padRectangular(m).map(row => { const y = row.slice(); y.splice(c, 0, ''); return y }),
  insertColRight: (m, _r, c) => padRectangular(m).map(row => { const y = row.slice(); y.splice(c + 1, 0, ''); return y }),
  deleteCol:      (m, _r, c) => m.map(row => { const y = row.slice(); y.splice(c, 1); return y }),
  moveRowUp:   (m, r) => { if (r < 2) return m; const x = m.slice(); [x[r-1],x[r]]=[x[r],x[r-1]]; return x },
  moveRowDown: (m, r) => { if (r < 1 || r >= m.length-1) return m; const x = m.slice(); [x[r],x[r+1]]=[x[r+1],x[r]]; return x },
  moveColLeft: (m, _r, c) => { if (c < 1) return m; return m.map(row => { const y=row.slice(); [y[c-1],y[c]]=[y[c],y[c-1]]; return y }) },
  moveColRight:(m, _r, c) => m.map(row => { if (c >= row.length-1) return row.slice(); const y=row.slice(); [y[c],y[c+1]]=[y[c+1],y[c]]; return y }),
  sortColAsc:  (m, _r, c) => sortBody(m, c, 1),
  sortColDesc: (m, _r, c) => sortBody(m, c, -1)
}

// Move arr[from] to a gap index (0..len): the slot between elements,
// as used by drag-and-drop. gap === from or from+1 is a no-op.
const arrMoveGap = (arr, from, gap) => {
  const x = arr.slice()
  const [v] = x.splice(from, 1)
  x.splice(gap > from ? gap - 1 : gap, 0, v)
  return x
}
// Reorder whole columns (header included) to a drop gap.
const moveColumnTo = (m, from, gap) => {
  const cols = Math.max(0, ...m.map(r => r.length))
  const order = arrMoveGap(Array.from({ length: cols }, (_, i) => i), from, gap)
  return m.map(row => order.map(i => row[i] ?? ''))
}
// Reorder body rows (header row 0 fixed); indices are body-relative.
const moveRowTo = (m, from, gap) => {
  if (m.length < 2) return m
  return [m[0], ...arrMoveGap(m.slice(1), from, gap)]
}

// 14px line icons (stroke=currentColor), matching the edit-pencil SVG style
// used elsewhere. Chevron = direction of insertion; trash = delete.
const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  insertRowAbove: SVG('<polyline points="8 8 12 4 16 8"/><line x1="12" y1="4" x2="12" y2="13"/><rect x="4" y="17" width="16" height="4" rx="1"/>'),
  insertRowBelow: SVG('<rect x="4" y="3" width="16" height="4" rx="1"/><line x1="12" y1="11" x2="12" y2="20"/><polyline points="8 16 12 20 16 16"/>'),
  // deleteRow / deleteCol: SVGs adapted from tgrosinger/advanced-tables-obsidian
  // (MIT). Filled icons with their original viewBoxes; the rest of ICONS use
  // the stroked SVG() helper. https://github.com/tgrosinger/advanced-tables-obsidian
  deleteRow: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 15.381 15.381" fill="currentColor"><path d="M0,1.732v7.732h6.053c0-0.035-0.004-0.07-0.004-0.104c0-0.434,0.061-0.854,0.165-1.255H1.36V3.092h12.662v2.192c0.546,0.396,1.01,0.897,1.359,1.477V1.732H0z"/><path d="m11.196 5.28c-2.307 0-4.183 1.877-4.183 4.184 0 2.308 1.876 4.185 4.183 4.185 2.309 0 4.185-1.877 4.185-4.185 0-2.307-1.876-4.184-4.185-4.184zm0 7.233c-1.679 0-3.047-1.367-3.047-3.049 0-1.68 1.368-3.049 3.047-3.049 1.684 0 3.05 1.369 3.05 3.049 0 1.682-1.366 3.049-3.05 3.049z"/><rect x="9.312" y="8.759" width="3.844" height="1.104"/></svg>',
  insertColLeft: SVG('<polyline points="8 8 4 12 8 16"/><line x1="4" y1="12" x2="13" y2="12"/><rect x="17" y="4" width="4" height="16" rx="1"/>'),
  insertColRight: SVG('<rect x="3" y="4" width="4" height="16" rx="1"/><line x1="11" y1="12" x2="20" y2="12"/><polyline points="16 8 20 12 16 16"/>'),
  deleteCol: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 26 26" fill="currentColor"><path d="m13.594 20.85v3.15h-10v-22h10v3.15c0.633-0.323 1.304-0.565 2-0.727v-3.423c0-0.551-0.448-1-1-1h-12c-0.55 0-1 0.449-1 1v24c0 0.551 0.449 1 1 1h12c0.552 0 1-0.449 1-1v-3.424c-0.696-0.161-1.367-0.403-2-0.726z"/><path d="m17.594 6.188c-3.762 0-6.813 3.051-6.812 6.813-1e-3 3.761 3.05 6.812 6.812 6.812s6.813-3.051 6.813-6.813-3.052-6.812-6.813-6.812zm3.632 7.802-7.267 1e-3v-1.982h7.268l-1e-3 1.981z"/></svg>',
  moveRowUp:   SVG('<line x1="12" y1="20" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>'),
  moveRowDown: SVG('<line x1="12" y1="4" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>'),
  moveColLeft: SVG('<line x1="20" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/>'),
  moveColRight:SVG('<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  sortColAsc:  SVG('<path d="M11 5h3M11 10h6M11 15h9"/><polyline points="4 8 7 5 10 8"/><line x1="7" y1="5" x2="7" y2="19"/>'),
  sortColDesc: SVG('<path d="M11 5h9M11 10h6M11 15h3"/><polyline points="4 16 7 19 10 16"/><line x1="7" y1="5" x2="7" y2="19"/>'),
  pin: SVG('<line x1="12" y1="17" x2="12" y2="22"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/>'),
  // Maximise = expand to Logseq's window bounds (covers sidebars/blocks).
  // A framed box with inward arrows; the exit variant has the arrows outward.
  maximise:     SVG('<rect x="3" y="3" width="18" height="18" rx="1"/><polyline points="8 13 8 16 11 16"/><polyline points="16 11 16 8 13 8"/>'),
  exitMaximise: SVG('<rect x="3" y="3" width="18" height="18" rx="1"/><polyline points="13 8 16 8 16 11"/><polyline points="11 16 8 16 8 13"/>')
}

// Overlay host for popovers/toolbars. The renderer is reparented to <body>
// while maximised, so mounting popups on <body> keeps them above it.
const overlayHost = (doc) => doc.body

const closeMenu = (doc) => {
  const el = doc.querySelector('.lsp-mdt-menu')
  if (el && el._cleanup) el._cleanup()
  if (el) el.remove()
}

// Shared item model for both the right-click menu and the pinned toolbar.
// Returns the matrix-op items plus `ord` (which table in a multi-table
// block). The pin toggle is appended separately by each caller since its
// action depends on the surface.
const buildItems = (root, opts, cell) => {
  const tableEl = cell.closest('table.lsp-mdt')
  const tr = cell.closest('tr')
  const rowIdx = Array.from(tableEl.querySelectorAll('tr')).indexOf(tr)
  const colIdx = Array.from(tr.querySelectorAll('th,td')).indexOf(cell)
  const ord = Array.from(root.querySelectorAll('table.lsp-mdt')).indexOf(tableEl)
  const rowCount = tableEl.querySelectorAll('tr').length
  const colCount = tr.querySelectorAll('th,td').length
  const L = opts.menuLabels || {}
  const items = [
    { icon: ICONS.insertRowAbove, label: L.insertRowAbove || 'Insert row above', enabled: rowIdx >= 1,
      shortcut: 'Alt+Ctrl+Shift+Up', run: m => tableOps.insertRowAbove(m, rowIdx) },
    { icon: ICONS.insertRowBelow, label: L.insertRowBelow || 'Insert row below', enabled: true,
      shortcut: 'Alt+Ctrl+Shift+Down', run: m => tableOps.insertRowBelow(m, rowIdx) },
    { icon: ICONS.moveRowUp, label: L.moveRowUp || 'Move row up', enabled: rowIdx >= 2,
      shortcut: 'Alt+Shift+Up', run: m => tableOps.moveRowUp(m, rowIdx) },
    { icon: ICONS.moveRowDown, label: L.moveRowDown || 'Move row down', enabled: rowIdx >= 1 && rowIdx < rowCount - 1,
      shortcut: 'Alt+Shift+Down', run: m => tableOps.moveRowDown(m, rowIdx) },
    { icon: ICONS.deleteRow, label: L.deleteRow || 'Delete row', enabled: rowCount >= 2,
      run: m => tableOps.deleteRow(m, rowIdx) },
    { sep: true },
    { icon: ICONS.insertColLeft, label: L.insertColLeft || 'Insert column left', enabled: true,
      shortcut: 'Alt+Ctrl+Shift+Left', run: m => tableOps.insertColLeft(m, rowIdx, colIdx) },
    { icon: ICONS.insertColRight, label: L.insertColRight || 'Insert column right', enabled: true,
      shortcut: 'Alt+Ctrl+Shift+Right', run: m => tableOps.insertColRight(m, rowIdx, colIdx) },
    { icon: ICONS.moveColLeft, label: L.moveColLeft || 'Move column left', enabled: colIdx >= 1,
      shortcut: 'Alt+Shift+Left', run: m => tableOps.moveColLeft(m, rowIdx, colIdx) },
    { icon: ICONS.moveColRight, label: L.moveColRight || 'Move column right', enabled: colIdx < colCount - 1,
      shortcut: 'Alt+Shift+Right', run: m => tableOps.moveColRight(m, rowIdx, colIdx) },
    { icon: ICONS.deleteCol, label: L.deleteCol || 'Delete column', enabled: colCount >= 2,
      run: m => tableOps.deleteCol(m, rowIdx, colIdx) },
    { sep: true },
    { icon: ICONS.sortColAsc, label: L.sortColAsc || 'Sort column ascending', enabled: rowCount >= 3,
      run: m => tableOps.sortColAsc(m, rowIdx, colIdx) },
    { icon: ICONS.sortColDesc, label: L.sortColDesc || 'Sort column descending', enabled: rowCount >= 3,
      run: m => tableOps.sortColDesc(m, rowIdx, colIdx) }
  ]
  return { items, ord }
}

const isPinned = (opts) => !!(opts.isPinned && opts.isPinned())

// Maximise = expand the renderer to fill Logseq's window (covering sidebars
// and other blocks), without entering OS-level fullscreen. Implementation:
// reparent the renderer to <body> so ancestor transforms / overflow / stacking
// contexts can't constrain a `position: fixed; inset: 0` overlay. A comment
// placeholder marks the original slot so we can restore it on exit. The DOM
// node itself isn't recreated, so editing hooks, drag handlers and the
// pinned toolbar all keep working.
const isMaximised = (root) => root.classList.contains('lsp-mdt-max')

const maximiseRenderer = (root) => {
  if (isMaximised(root)) return
  const doc = root.ownerDocument
  const parent = root.parentNode
  if (!parent || parent === doc.body) return
  const placeholder = doc.createComment('lsp-mdt-max-placeholder')
  parent.insertBefore(placeholder, root)
  root.__mdtMaxPlaceholder = placeholder
  doc.body.appendChild(root)
  root.classList.add('lsp-mdt-max')
  bindMaximiseEsc(doc)
  // Refit so the table can use the full window width.
  try { fitInlineTableWidth(root) } catch (e) { /* noop */ }
}

const unmaximiseRenderer = (root) => {
  if (!isMaximised(root)) return
  root.classList.remove('lsp-mdt-max')
  const ph = root.__mdtMaxPlaceholder
  if (ph && ph.parentNode) {
    ph.parentNode.insertBefore(root, ph)
    ph.remove()
  }
  root.__mdtMaxPlaceholder = null
  try { fitInlineTableWidth(root) } catch (e) { /* noop */ }
}

// One Esc listener per document exits whichever renderer is currently
// maximised. Cheap to leave installed for the life of the document.
const maximiseEscDocs = new WeakSet()
const bindMaximiseEsc = (doc) => {
  if (maximiseEscDocs.has(doc)) return
  maximiseEscDocs.add(doc)
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const max = doc.querySelector('.lsp-mdtable-renderer.lsp-mdt-max')
    if (!max) return
    // Don't fight an open menu / popover — let its own Esc handler run first.
    if (doc.querySelector('.lsp-mdt-menu')) return
    e.preventDefault()
    e.stopPropagation()
    unmaximiseRenderer(max)
    removeToolbar(doc)
  }, true)
}

// Maximise toggle item; lives next to Pin/Unpin in both surfaces.
const maximiseItem = (root, opts, after) => {
  const max = isMaximised(root)
  const L = opts.menuLabels || {}
  return {
    icon: max ? ICONS.exitMaximise : ICONS.maximise,
    label: max ? (L.exitMaximise || 'Exit maximise') : (L.maximise || 'Maximise'),
    enabled: true,
    action: () => {
      if (max) unmaximiseRenderer(root)
      else maximiseRenderer(root)
      if (after) after(!max)
    }
  }
}

// Pin/Unpin toggle item; `after(nowPinned)` lets the surface refresh.
const pinItem = (opts, after) => {
  const L = opts.menuLabels || {}
  return {
    icon: ICONS.pin,
    label: isPinned(opts) ? (L.unpinToolbar || 'Unpin toolbar') : (L.pinToolbar || 'Pin toolbar'),
    enabled: true,
    action: () => {
      const now = !isPinned(opts)
      if (opts.setPinned) opts.setPinned(now)
      after(now)
    }
  }
}

const removeToolbar = (doc) => {
  const t = doc.querySelector('.lsp-mdt-toolbar')
  if (t) t.remove()
}

// One scroll/resize binding per document keeps the pinned toolbar glued
// to whichever cell currently has focus (stateless: no per-attach leak).
const toolbarReflowDocs = new WeakSet()
const bindToolbarReflow = (doc) => {
  if (toolbarReflowDocs.has(doc)) return
  toolbarReflowDocs.add(doc)
  const win = doc.defaultView || window
  const reflow = () => {
    const bar = doc.querySelector('.lsp-mdt-toolbar')
    if (!bar) return
    const a = doc.activeElement
    const cell = a && a.closest && a.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (cell && cell.isConnected) positionToolbar(cell, bar)
  }
  win.addEventListener('scroll', reflow, true)
  win.addEventListener('resize', reflow)
}

const positionToolbar = (cell, bar) => {
  const doc = bar.ownerDocument
  const r = cell.getBoundingClientRect()
  // Confine the toolbar to the renderer's bounds so it can't drift over
  // the sidebars or other blocks when the user scrolls the cell off-screen
  // (vertically out of view, or horizontally past the table's scroll box).
  const renderer = cell.closest('.lsp-mdtable-renderer')
  const rr = renderer ? renderer.getBoundingClientRect() : r
  const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight
  // Visible slice of the renderer within the viewport.
  const visL = Math.max(4, rr.left)
  const visR = Math.min(vw - 4, rr.right)
  const visT = Math.max(4, rr.top)
  const visB = Math.min(vh - 4, rr.bottom)
  // If the cell isn't visible inside the renderer's visible slice at all,
  // hide the toolbar rather than parking it somewhere unrelated.
  const cellVisible =
    r.right > visL && r.left < visR && r.bottom > visT && r.top < visB
  if (!cellVisible || visR <= visL || visB <= visT) {
    bar.style.visibility = 'hidden'
    return
  }
  bar.style.visibility = 'hidden'
  const bw = bar.offsetWidth, bh = bar.offsetHeight
  // For very short tables (≤2 rows total), the default below-cell anchor
  // would sit on top of the other row. Anchor above the whole block instead
  // and don't clamp it back inside the renderer — the toolbar is allowed to
  // extend above the block (over the page chrome) so it never covers a row.
  const table = cell.closest('table.lsp-mdt')
  const rowCount = table ? table.querySelectorAll('tr').length : 0
  const tr = table ? table.getBoundingClientRect() : r
  const shortTable = rowCount > 0 && rowCount <= 2
  let top, clampTop = visT
  if (shortTable) {
    top = tr.top - bh - 4
    clampTop = 4 // allow toolbar above the renderer, but keep it on-screen
  } else {
    top = r.bottom + 4
    if (top + bh > visB) top = Math.max(visT, r.top - bh - 4) // flip above
  }
  top = Math.max(clampTop, Math.min(top, visB - bh))
  const left = Math.max(visL, Math.min(r.left, visR - bw))
  bar.style.left = left + 'px'
  bar.style.top = top + 'px'
  bar.style.visibility = ''
}

// Build the pinned icon-only horizontal toolbar under `cell`.
const buildToolbar = (root, opts, cell) => {
  const doc = root.ownerDocument
  removeToolbar(doc)
  if (!cell || !cell.isConnected) return
  const { items, ord } = buildItems(root, opts, cell)
  const aTr = cell.closest('tr')
  const aRow = Array.from(cell.closest('table.lsp-mdt').querySelectorAll('tr')).indexOf(aTr)
  const aCol = Array.from(aTr.querySelectorAll('th,td')).indexOf(cell)
  const all = items.concat([{ sep: true },
    maximiseItem(root, opts, () => buildToolbar(root, opts, cell)),
    pinItem(opts, () => removeToolbar(doc))]) // pinned bar's toggle = unpin

  const bar = doc.createElement('div')
  bar.className = 'lsp-mdt-toolbar'
  all.forEach(it => {
    if (it.sep) { const s = doc.createElement('span'); s.className = 'lsp-mdt-tb-sep'; bar.appendChild(s); return }
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'lsp-mdt-tb-btn' + (it.enabled ? '' : ' disabled')
    b.title = it.label
    b.innerHTML = it.icon || ''
    if (it.enabled) {
      b.addEventListener('mousedown', (e) => e.preventDefault()) // keep cell focus
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        if (it.action) { it.action(); return }
        // Re-anchor the toolbar to this position after the re-render.
        pendingToolbar.set(opts.blockId, { ord, rowIdx: aRow, colIdx: aCol })
        commitStructural(root, opts, (m, i) => (i === ord ? it.run(m) : m))
        removeToolbar(doc)
      })
    }
    bar.appendChild(b)
  })
  overlayHost(doc).appendChild(bar)
  positionToolbar(cell, bar)
}

const openContextMenu = (root, opts, cell, ev) => {
  const doc = root.ownerDocument
  const win = doc.defaultView || window
  closeMenu(doc)

  const { items, ord } = buildItems(root, opts, cell)
  const all = items.concat([{ sep: true },
    maximiseItem(root, opts),
    pinItem(opts, (now) => { if (now) buildToolbar(root, opts, cell); else removeToolbar(doc) })])

  const menu = doc.createElement('div')
  menu.className = 'lsp-mdt-menu'
  all.forEach(it => {
    if (it.sep) { const s = doc.createElement('div'); s.className = 'lsp-mdt-menu-sep'; menu.appendChild(s); return }
    const mi = doc.createElement('div')
    mi.className = 'lsp-mdt-menu-item' + (it.enabled ? '' : ' disabled')
    // Native tooltip surfaces the keybind on hover for items that have
    // one. Reflects the hardcoded default in `attachInlineEditing`; an
    // extra shortcut the user assigned via Logseq's keymap UI would
    // fire too, but isn't shown here.
    if (it.shortcut) mi.title = it.shortcut
    const ic = doc.createElement('span')
    ic.className = 'lsp-mdt-menu-icon'
    ic.innerHTML = it.icon || ''
    const lb = doc.createElement('span')
    lb.textContent = it.label
    mi.appendChild(ic)
    mi.appendChild(lb)
    if (it.enabled) {
      mi.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        closeMenu(doc)
        if (it.action) { it.action(); return }
        commitStructural(root, opts, (m, i) => (i === ord ? it.run(m) : m))
      })
    }
    menu.appendChild(mi)
  })

  // Off-screen first so we can measure, then clamp into the viewport.
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  overlayHost(doc).appendChild(menu)
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight
  menu.style.left = Math.max(4, Math.min(ev.clientX, vw - mw - 4)) + 'px'
  menu.style.top = Math.max(4, Math.min(ev.clientY, vh - mh - 4)) + 'px'

  const onDocPointer = (e) => { if (!menu.contains(e.target)) closeMenu(doc) }
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(doc) }
  const onGone = () => closeMenu(doc)
  doc.addEventListener('pointerdown', onDocPointer, true)
  doc.addEventListener('keydown', onKey, true)
  win.addEventListener('blur', onGone)
  win.addEventListener('resize', onGone)
  doc.addEventListener('scroll', onGone, true)
  menu._cleanup = () => {
    doc.removeEventListener('pointerdown', onDocPointer, true)
    doc.removeEventListener('keydown', onKey, true)
    win.removeEventListener('blur', onGone)
    win.removeEventListener('resize', onGone)
    doc.removeEventListener('scroll', onGone, true)
  }
}

// --- Edge drag-reorder ---------------------------------------------------
//
// The top edge of the header row is a column-drag handle; the left edge of
// each body row's first cell is a row-drag handle. Pointer based (no React
// DOM restructuring): on drop we compute the target gap from live cell
// rects and reorder via the same commitStructural path as everything else.
const DRAG_EDGE = 10      // px band along the table edge that grabs
const DRAG_THRESHOLD = 4  // px before a press becomes a drag

const dropLine = (doc) => {
  let el = doc.querySelector('.lsp-mdt-dropline')
  if (!el) { el = doc.createElement('div'); el.className = 'lsp-mdt-dropline'; overlayHost(doc).appendChild(el) }
  return el
}
const removeDropLine = (doc) => {
  const el = doc.querySelector('.lsp-mdt-dropline')
  if (el) el.remove()
}

const attachDragReorder = (root, opts) => {
  const doc = root.ownerDocument

  // Which edge handle (if any) is under the pointer.
  const edgeZone = (e) => {
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return null
    const table = cell.closest('table.lsp-mdt')
    const r = cell.getBoundingClientRect()
    if (cell.closest('thead') && e.clientY - r.top <= DRAG_EDGE) {
      const ths = Array.from(table.querySelectorAll('thead th'))
      return { mode: 'col', table, from: ths.indexOf(cell), el: cell }
    }
    const tr = cell.closest('tr')
    if (!cell.closest('thead') && tr && cell === tr.querySelector('th,td') &&
        e.clientX - r.left <= DRAG_EDGE) {
      const rows = Array.from(table.querySelectorAll('tbody tr'))
      return { mode: 'row', table, from: rows.indexOf(tr), el: cell }
    }
    return null
  }

  const colGap = (table, x) => {
    const ths = Array.from(table.querySelectorAll('thead th'))
    let gap = ths.length
    for (let i = 0; i < ths.length; i++) {
      const r = ths[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) { gap = i; break }
    }
    return { gap, els: ths }
  }
  const rowGap = (table, y) => {
    const rows = Array.from(table.querySelectorAll('tbody tr'))
    let gap = rows.length
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) { gap = i; break }
    }
    return { gap, els: rows }
  }

  const draw = (st) => {
    const tr = st.table.getBoundingClientRect()
    const el = dropLine(doc)
    if (st.mode === 'col') {
      const els = st.els
      const x = st.gap >= els.length
        ? els[els.length - 1].getBoundingClientRect().right
        : els[st.gap].getBoundingClientRect().left
      el.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;width:2px;` +
        `background:var(--ls-active-primary-color,#2563eb);left:${x}px;top:${tr.top}px;height:${tr.height}px;`
    } else {
      const els = st.els
      const y = !els.length ? tr.bottom
        : st.gap >= els.length
          ? els[els.length - 1].getBoundingClientRect().bottom
          : els[st.gap].getBoundingClientRect().top
      el.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;height:2px;` +
        `background:var(--ls-active-primary-color,#2563eb);top:${y}px;left:${tr.left}px;width:${tr.width}px;`
    }
  }

  let st = null

  // Hover affordance: blue highlight on the handle edge of the column/row
  // that would be grabbed (not shown while dragging).
  let hoverEl = null
  const EDGE_CLASSES = ['lsp-mdt-edge-col', 'lsp-mdt-edge-row']
  const clearHover = () => {
    if (hoverEl) hoverEl.classList.remove(...EDGE_CLASSES)
    hoverEl = null
    root.classList.remove('lsp-mdt-grab')
  }
  const setHover = (z) => {
    const el = z && z.el
    if (el !== hoverEl) {
      if (hoverEl) hoverEl.classList.remove(...EDGE_CLASSES)
      hoverEl = el || null
      if (el) el.classList.add(z.mode === 'col' ? 'lsp-mdt-edge-col' : 'lsp-mdt-edge-row')
    }
    root.classList.toggle('lsp-mdt-grab', !!el)
  }

  root.addEventListener('pointermove', (e) => {
    if (!st) { setHover(edgeZone(e)); return }
    if (!st.moved) {
      if (Math.abs(e.clientX - st.x0) + Math.abs(e.clientY - st.y0) < DRAG_THRESHOLD) return
      st.moved = true
    }
    const g = st.mode === 'col' ? colGap(st.table, e.clientX) : rowGap(st.table, e.clientY)
    st.gap = g.gap; st.els = g.els
    draw(st)
  })
  root.addEventListener('pointerleave', () => { if (!st) clearHover() })

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const z = edgeZone(e)
    if (!z || z.from < 0) return
    e.preventDefault(); e.stopPropagation()
    st = { ...z, x0: e.clientX, y0: e.clientY, moved: false, gap: null, els: [],
           ord: Array.from(root.querySelectorAll('table.lsp-mdt')).indexOf(z.table) }
    try { root.setPointerCapture(e.pointerId) } catch (_) { /* noop */ }
    clearHover() // no hover highlight while dragging
    root.classList.add('lsp-mdt-dragging')
  }, true)

  const finish = (commit) => {
    if (!st) return
    const s = st; st = null
    root.classList.remove('lsp-mdt-dragging')
    clearHover()
    removeDropLine(doc)
    if (!commit || !s.moved || s.gap == null) return
    if (s.gap === s.from || s.gap === s.from + 1) return // dropped in place
    const op = s.mode === 'col' ? moveColumnTo : moveRowTo
    commitStructural(root, opts, (m, i) => (i === s.ord ? op(m, s.from, s.gap) : m))
  }

  root.addEventListener('pointerup', (e) => {
    if (!st) return
    e.preventDefault(); e.stopPropagation()
    finish(true)
  }, true)
  root.addEventListener('pointercancel', () => finish(false), true)
  doc.addEventListener('keydown', (e) => {
    if (st && e.key === 'Escape') { e.stopPropagation(); finish(false) }
  }, true)
}

// Attach editing behaviour to a freshly-rendered renderer root. Idempotent:
// if Logseq reuses the DOM node across re-renders we don't double-bind.
export const attachInlineEditing = (root, opts) => {
  if (!root) return

  // Re-apply every render (idempotent): if Logseq reuses the root node but
  // replaces the inner table, the new cells must still become editable and
  // focusable — otherwise editing and toolbar refocus break after an op.
  root.querySelectorAll('table.lsp-mdt th, table.lsp-mdt td').forEach(cell => {
    cell.setAttribute('contenteditable', 'true')
    cell.setAttribute('tabindex', '0')
    cell.spellcheck = false
  })

  // Stashed every render (opts is rebuilt by the React ref each pass) so
  // the globally-invoked insert helpers can recover the latest closures
  // (updateBlock, segments, blockId) for whichever renderer holds focus.
  root._lspInlineOpts = opts

  // Listeners are delegated on root; bind them only once per node.
  if (root.dataset.lspInlineEdit === '1') return
  root.dataset.lspInlineEdit = '1'

  // Capture phase: stop pointer/key events from reaching Logseq, which would
  // otherwise swap the block into its raw textarea and unmount this renderer.
  const swallow = (e) => {
    if (e.target.closest('table.lsp-mdt th, table.lsp-mdt td')) e.stopPropagation()
  }
  root.addEventListener('mousedown', swallow, true)
  root.addEventListener('click', swallow, true)
  root.addEventListener('keydown', swallow, true)
  root.addEventListener('dblclick', swallow, true)

  // Ctrl+Enter / Ctrl+Shift+Enter: move caret to the cell below/above.
  // Handled locally because the contenteditable cell would otherwise eat
  // the Enter (inserting a <br>) before Logseq's command-shortcut
  // dispatcher sees it. The matching commands are also registered with
  // Logseq so they appear in the command palette / keymap UI.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.ctrlKey) return
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault(); e.stopPropagation()
    moveCaretInFocusedTableCell(e.shiftKey ? 'up' : 'down')
  }, true)

  // Alt+Ctrl+Arrow: caret nav between adjacent cells in the table. Local
  // handler for the same reason as the Ctrl+Enter / Alt+Ctrl+Shift+Arrow paths
  // (capture-phase swallowing hides the keys from Logseq's dispatcher);
  // matching commands are registered with Logseq so they appear in the
  // command palette / keymap UI.
  const caretNavKey = (e) => {
    if (!e.altKey || !e.ctrlKey || e.shiftKey || e.metaKey) return null
    if (e.key === 'ArrowDown') return 'down'
    if (e.key === 'ArrowUp') return 'up'
    if (e.key === 'ArrowRight') return 'right'
    if (e.key === 'ArrowLeft') return 'left'
    return null
  }
  root.addEventListener('keydown', (e) => {
    const dir = caretNavKey(e)
    if (!dir) return
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault(); e.stopPropagation()
    moveCaretInFocusedTableCell(dir)
  }, true)

  // Alt+Ctrl+Shift+Arrow: insert a row above/below or a column left/right
  // of the focused cell. Local handler for the same reason as Ctrl+Enter —
  // capture-phase swallowing means Logseq never sees the key, so a
  // global shortcut would be unreliable; the registered commands below
  // mirror these actions for the palette / keymap UI.
  const insertKey = (e) => {
    if (!e.altKey || !e.shiftKey || !e.ctrlKey || e.metaKey) return null
    if (e.key === 'ArrowDown') return 'rowBelow'
    if (e.key === 'ArrowUp') return 'rowAbove'
    if (e.key === 'ArrowRight') return 'colRight'
    if (e.key === 'ArrowLeft') return 'colLeft'
    return null
  }
  root.addEventListener('keydown', (e) => {
    const which = insertKey(e)
    if (!which) return
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault(); e.stopPropagation()
    doInsertOp(root, opts, cell, which)
  }, true)

  // Alt+Shift+Arrow: move the focused row/column. Local handler (same
  // capture-phase reason as the other in-table keybinds); registered
  // commands below mirror these for the palette / keymap UI.
  const moveKey = (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null
    if (e.key === 'ArrowDown') return 'rowDown'
    if (e.key === 'ArrowUp') return 'rowUp'
    if (e.key === 'ArrowRight') return 'colRight'
    if (e.key === 'ArrowLeft') return 'colLeft'
    return null
  }
  root.addEventListener('keydown', (e) => {
    const which = moveKey(e)
    if (!which) return
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault(); e.stopPropagation()
    doMoveOp(root, opts, cell, which)
  }, true)

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

  // Custom right-click menu (row/column ops). preventDefault so neither
  // Logseq's nor Electron's native menu opens over the table.
  root.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(root, opts, cell, e)
  }, true)

  attachDragReorder(root, opts)

  // Pinned toolbar: while pinned, an icon-only horizontal toolbar tracks
  // the focused cell (appears under it). Right-clicking still opens the
  // full labelled menu.
  root.addEventListener('focusin', (e) => {
    const cell = e.target.closest && e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (cell && isPinned(opts)) buildToolbar(root, opts, cell)
  })
  root.addEventListener('focusout', (e) => {
    const to = e.relatedTarget
    if (to && to.closest && (to.closest('table.lsp-mdt') || to.closest('.lsp-mdt-toolbar'))) return
    setTimeout(() => {
      const a = root.ownerDocument.activeElement
      if (!a || !(a.closest && (a.closest('table.lsp-mdt') || a.closest('.lsp-mdt-toolbar')))) {
        removeToolbar(root.ownerDocument)
      }
    }, 0)
  })
  bindToolbarReflow(root.ownerDocument)
}

// After a structural action re-renders the block, refocus the cell at
// the stashed position so the caret lands where the user expects (and,
// if the toolbar is pinned, re-anchor it there too). Called from the
// renderer ref on every (re-)mount, so it works whether Logseq reuses
// or replaces the root node.
export const resumePinnedToolbar = (root, opts) => {
  const pend = pendingToolbar.get(opts.blockId)
  if (!pend) return
  const win = root.ownerDocument.defaultView || window
  const pinned = isPinned(opts)
  // Try this render; if the table isn't resolvable yet (stale/intermediate
  // render), keep `pend` so a later render retries instead of burning it.
  const tryShow = (retry) => {
    const tables = root.querySelectorAll('table.lsp-mdt')
    const tableEl = tables[Math.min(pend.ord, tables.length - 1)]
    const rows = tableEl && tableEl.querySelectorAll('tr')
    const row = rows && rows[Math.min(pend.rowIdx, rows.length - 1)]
    const cells = row && row.querySelectorAll('th,td')
    const cell = cells && cells[Math.min(pend.colIdx, cells.length - 1)]
    if (!cell || !cell.isConnected) {
      if (retry > 0) win.setTimeout(() => tryShow(retry - 1), 50)
      return
    }
    pendingToolbar.delete(opts.blockId)
    if (pinned) buildToolbar(root, opts, cell) // build directly — don't depend on focus
    caretToEnd(cell)                            // caret continuity for the next op
  }
  win.requestAnimationFrame(() => tryShow(3))
}

// Called when the renderer for a block is torn down / re-created so a pending
// debounce doesn't fire against a stale DOM.
export const cancelInlineEditing = (blockId) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.delete(blockId)
}
