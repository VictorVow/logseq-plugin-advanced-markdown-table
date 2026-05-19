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
  win.addEventListener('resize', () => {
    clearTimeout(t)
    t = setTimeout(() => {
      doc.querySelectorAll('.lsp-mdtable-renderer').forEach(fitInlineTableWidth)
    }, 100)
  })
}

// Called from the renderer's ref on every (re-)mount, regardless of whether
// in-place editing is enabled — the overflow exists in read-only mode too.
export const prepareInlineRenderer = (root) => {
  if (!root) return
  fitInlineTableWidth(root)
  // The ref can fire before Logseq has placed the element / laid out its
  // ancestors; remeasure after the next frame once layout has settled.
  const win = root.ownerDocument.defaultView || window
  win.requestAnimationFrame(() => fitInlineTableWidth(root))
  bindResizeRefit(root)
}

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

// 14px line icons (stroke=currentColor), matching the edit-pencil SVG style
// used elsewhere. Chevron = direction of insertion; trash = delete.
const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  insertRowAbove: SVG('<polyline points="8 8 12 4 16 8"/><line x1="12" y1="4" x2="12" y2="13"/><rect x="4" y="17" width="16" height="4" rx="1"/>'),
  insertRowBelow: SVG('<rect x="4" y="3" width="16" height="4" rx="1"/><line x1="12" y1="11" x2="12" y2="20"/><polyline points="8 16 12 20 16 16"/>'),
  deleteRow: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  insertColLeft: SVG('<polyline points="8 8 4 12 8 16"/><line x1="4" y1="12" x2="13" y2="12"/><rect x="17" y="4" width="4" height="16" rx="1"/>'),
  insertColRight: SVG('<rect x="3" y="4" width="4" height="16" rx="1"/><line x1="11" y1="12" x2="20" y2="12"/><polyline points="16 8 20 12 16 16"/>'),
  deleteCol: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  moveRowUp:   SVG('<line x1="12" y1="20" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>'),
  moveRowDown: SVG('<line x1="12" y1="4" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>'),
  moveColLeft: SVG('<line x1="20" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/>'),
  moveColRight:SVG('<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  sortColAsc:  SVG('<path d="M11 5h3M11 10h6M11 15h9"/><polyline points="4 8 7 5 10 8"/><line x1="7" y1="5" x2="7" y2="19"/>'),
  sortColDesc: SVG('<path d="M11 5h9M11 10h6M11 15h3"/><polyline points="4 16 7 19 10 16"/><line x1="7" y1="5" x2="7" y2="19"/>')
}

const closeMenu = (doc) => {
  const el = doc.querySelector('.lsp-mdt-menu')
  if (el && el._cleanup) el._cleanup()
  if (el) el.remove()
}

const openContextMenu = (root, opts, cell, ev) => {
  const doc = root.ownerDocument
  const win = doc.defaultView || window
  closeMenu(doc)

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
      run: m => tableOps.insertRowAbove(m, rowIdx) },
    { icon: ICONS.insertRowBelow, label: L.insertRowBelow || 'Insert row below', enabled: true,
      run: m => tableOps.insertRowBelow(m, rowIdx) },
    { icon: ICONS.moveRowUp, label: L.moveRowUp || 'Move row up', enabled: rowIdx >= 2,
      run: m => tableOps.moveRowUp(m, rowIdx) },
    { icon: ICONS.moveRowDown, label: L.moveRowDown || 'Move row down', enabled: rowIdx >= 1 && rowIdx < rowCount - 1,
      run: m => tableOps.moveRowDown(m, rowIdx) },
    { icon: ICONS.deleteRow, label: L.deleteRow || 'Delete row', enabled: rowCount >= 2,
      run: m => tableOps.deleteRow(m, rowIdx) },
    { sep: true },
    { icon: ICONS.insertColLeft, label: L.insertColLeft || 'Insert column left', enabled: true,
      run: m => tableOps.insertColLeft(m, rowIdx, colIdx) },
    { icon: ICONS.insertColRight, label: L.insertColRight || 'Insert column right', enabled: true,
      run: m => tableOps.insertColRight(m, rowIdx, colIdx) },
    { icon: ICONS.moveColLeft, label: L.moveColLeft || 'Move column left', enabled: colIdx >= 1,
      run: m => tableOps.moveColLeft(m, rowIdx, colIdx) },
    { icon: ICONS.moveColRight, label: L.moveColRight || 'Move column right', enabled: colIdx < colCount - 1,
      run: m => tableOps.moveColRight(m, rowIdx, colIdx) },
    { icon: ICONS.deleteCol, label: L.deleteCol || 'Delete column', enabled: colCount >= 2,
      run: m => tableOps.deleteCol(m, rowIdx, colIdx) },
    { sep: true },
    { icon: ICONS.sortColAsc, label: L.sortColAsc || 'Sort column ascending', enabled: rowCount >= 3,
      run: m => tableOps.sortColAsc(m, rowIdx, colIdx) },
    { icon: ICONS.sortColDesc, label: L.sortColDesc || 'Sort column descending', enabled: rowCount >= 3,
      run: m => tableOps.sortColDesc(m, rowIdx, colIdx) }
  ]

  const menu = doc.createElement('div')
  menu.className = 'lsp-mdt-menu'
  items.forEach(it => {
    if (it.sep) { const s = doc.createElement('div'); s.className = 'lsp-mdt-menu-sep'; menu.appendChild(s); return }
    const mi = doc.createElement('div')
    mi.className = 'lsp-mdt-menu-item' + (it.enabled ? '' : ' disabled')
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
        commitStructural(root, opts, (m, i) => (i === ord ? it.run(m) : m))
      })
    }
    menu.appendChild(mi)
  })

  // Off-screen first so we can measure, then clamp into the viewport.
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  doc.body.appendChild(menu)
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

  // Custom right-click menu (row/column ops). preventDefault so neither
  // Logseq's nor Electron's native menu opens over the table.
  root.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('table.lsp-mdt th, table.lsp-mdt td')
    if (!cell) return
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(root, opts, cell, e)
  }, true)
}

// Called when the renderer for a block is torn down / re-created so a pending
// debounce doesn't fire against a stale DOM.
export const cancelInlineEditing = (blockId) => {
  clearTimeout(debounceTimers.get(blockId))
  debounceTimers.delete(blockId)
}
