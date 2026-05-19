import '@logseq/libs'

import parseMarkdownTable from './utils/parseRawInputByMarkdownIt'
import { splitStrByTable } from './utils/splitStrByTable'
import { looksLikeMarkdownTable, markdownTableToMatrix } from './utils/detectMarkdownTable'
import { attachInlineEditing, prepareInlineRenderer, resumePinnedToolbar } from './utils/inlineEditable'
import i18n from './locales/i18n'
import './index.css'

const logseq = window.logseq
const logseqEditor = logseq.Editor

const isInBrowser = process.env.REACT_APP_ENV === 'browser'

const applyTheme = (mode) => {
  const isDark = mode === 'dark'
  document.documentElement.classList.toggle('dark', isDark)
  document.body.classList.toggle('dark', isDark)
}

// Settings schema
const settingsSchema = [
  {
    key: 'enableInlineRenderer',
    type: 'boolean',
    default: true,
    title: 'Inline table rendering',
    description: "Render markdown-table blocks inline as tables (replacing Logseq's native outline view). Requires a Logseq version that supports the experimental block renderer API; ignored on older versions. Reload the plugin after changing this."
  },
  {
    key: 'inlineEditable',
    type: 'boolean',
    default: true,
    title: 'Edit inline tables in place',
    description: "Make the inline-rendered table's cells editable directly (debounced auto-save back to the block). When off, the inline table is read-only. Requires \"Inline table rendering\". Reload the plugin after changing this."
  },
  {
    key: 'inlineEditDebounceMs',
    type: 'number',
    default: 500,
    title: 'Inline edit auto-save delay (ms)',
    description: 'How long after you stop typing in an inline table cell before the change is written back to the block. Reload the plugin after changing this.'
  },
  {
    key: 'monospaceTableSource',
    type: 'boolean',
    default: true,
    title: 'Monospace table source when editing',
    description: "While editing a block whose content is a markdown table, render its raw source in a monospace font so aligned tables (see the \"readable data\" toolbar action) actually line up in Logseq's editor. Reload the plugin after changing this."
  },
  {
    key: 'monoFontSizeOffset',
    type: 'number',
    default: -1,
    title: 'Monospace table font size offset (px)',
    description: "Adjust the monospace table-source font size relative to Logseq's base font, in pixels (e.g. -1 = 1px smaller, 0 = same, 2 = 2px larger). Reload the plugin after changing this."
  }
]

if (isInBrowser) {
  // Browser dev mode previously booted the (now-removed) modal editor; with
  // only the inline renderer left, there's nothing standalone to mount.
  applyTheme(window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
} else {
  logseq.useSettingsSchema(settingsSchema)

  logseq.ready().then(() => {
    logseq.App.getUserConfigs().then(configs => {
      i18n.changeLanguage(configs.preferredLanguage || 'en')
      applyTheme(configs.preferredThemeMode)
      if (typeof logseq.App.onThemeModeChanged === 'function') {
        logseq.App.onThemeModeChanged(({ mode }) => applyTheme(mode))
      }
      console.log('[faiz:] === markdown-table-editor-plugin loaded')

      // Slash command: insert a minimal 1x1 markdown table into the current
      // block. The inline renderer's `when` predicate (looksLikeMarkdownTable)
      // picks it up automatically, so the block immediately switches to the
      // custom table view.
      const insertEmptyTableCallback = async (e) => {
        // Minimal 1x1 markdown table: one header cell + one body cell. The
        // empty header looks odd but is required — a markdown table without
        // a header/separator row isn't recognised by parseMarkdownTable.
        const emptyTable = '|   |\n|---|\n|   |'
        try {
          const block = e?.uuid ? await logseqEditor.getBlock(e.uuid) : null
          if (block && (block.format ?? 'markdown') !== 'markdown') {
            return logseq.UI.showMsg(i18n.t('Markdown table editor only support markdown'), 'warning')
          }
          if (!block?.uuid) return
          await logseqEditor.updateBlock(block.uuid, emptyTable)
          // Exit edit mode so the inline renderer takes over instead of
          // showing the raw markdown in Logseq's editing textarea.
          try { await logseqEditor.exitEditingMode?.() } catch (_) { /* noop */ }

          // Wait for the renderer to mount, then drop the caret into the
          // first header cell (row 1) so the user can start typing immediately.
          let hostDoc = null
          try { hostDoc = (window.top || window.parent)?.document } catch (_) { /* cross-origin */ }
          if (!hostDoc) return
          const selector = `.lsp-mdtable-renderer[data-blockid="${CSS.escape(String(block.uuid))}"] table.lsp-mdt thead th`
          const deadline = Date.now() + 2000
          const tryFocus = () => {
            const cell = hostDoc.querySelector(selector)
            if (cell) {
              cell.focus()
              try {
                const win = hostDoc.defaultView || window
                const range = hostDoc.createRange()
                range.selectNodeContents(cell)
                range.collapse(true)
                const sel = win.getSelection()
                sel.removeAllRanges()
                sel.addRange(range)
              } catch (_) { /* noop */ }
              return
            }
            if (Date.now() < deadline) requestAnimationFrame(tryFocus)
          }
          requestAnimationFrame(tryFocus)
        } catch (err) {
          console.error('[markdown-table-editor] insert empty table failed', err)
        }
      }

      logseqEditor.registerSlashCommand('Markdown Table Editor', insertEmptyTableCallback)

      // Inline block renderer: replace Logseq's native view for markdown-table
      // blocks with an editable table. Host-mounted via the experimental
      // Experiments API; a clean no-op on older Logseq hosts.
      const inlineEnabled = logseq.settings?.enableInlineRenderer !== false
      const hasBlockRenderer = typeof logseq.Experiments?.registerBlockRenderer === 'function'
      if (inlineEnabled && hasBlockRenderer) {
        logseq.provideStyle(`
          /* min-width:0 lets this shrink inside Logseq's flex block layout;
             without it the max-content table stretches the whole block past
             the viewport (clipping the last column and hiding Logseq's
             top-right "Switch to outline view" button) instead of the
             wrapper below scrolling. */
          .lsp-mdtable-renderer {
            margin: 4px 0; width: 100%; max-width: 100%;
            min-width: 0; box-sizing: border-box;
          }
          .lsp-mdtable-renderer .lsp-mdtable-scroll {
            display: block; width: 100%; max-width: 100%;
            min-width: 0; box-sizing: border-box;
            overflow-x: auto; overflow-y: hidden;
          }
          .lsp-mdtable-renderer table.lsp-mdt {
            border-collapse: collapse;
            width: max-content !important; max-width: none !important;
            color: var(--ls-primary-text-color);
          }
          .lsp-mdtable-renderer .lsp-mdtable-scroll table.lsp-mdt th,
          .lsp-mdtable-renderer .lsp-mdtable-scroll table.lsp-mdt td {
            border: 1px solid var(--ls-border-color) !important;
            padding: 4px 8px !important;
            text-align: left !important;
            vertical-align: top !important;
            white-space: pre !important;
            word-break: normal !important;
          }
          .lsp-mdtable-renderer .lsp-mdtable-scroll table.lsp-mdt th {
            background: var(--ls-secondary-background-color) !important;
            font-weight: 600 !important;
          }
          .lsp-mdtable-renderer .lsp-mdtable-text { white-space: pre-wrap; opacity: .85; }
          .lsp-mdtable-renderer table.lsp-mdt th[contenteditable],
          .lsp-mdtable-renderer table.lsp-mdt td[contenteditable] {
            cursor: text;
          }
          .lsp-mdtable-renderer table.lsp-mdt th[contenteditable]:focus,
          .lsp-mdtable-renderer table.lsp-mdt td[contenteditable]:focus {
            outline: 2px solid var(--ls-active-primary-color, #2563eb) !important;
            outline-offset: -2px;
          }
          /* Full-screen view uses the browser's native Fullscreen API so the
             element overlays Logseq's UI regardless of ancestor stacking /
             transform contexts. The DOM doesn't move, so inline editing,
             the toolbar (mounted into the fullscreen element when active),
             drag-drop and right-click menus all keep working. */
          .lsp-mdtable-renderer:fullscreen {
            margin: 0; padding: 24px 32px;
            background: var(--ls-primary-background-color, #fff);
            overflow: auto; box-sizing: border-box;
          }
          .lsp-mdtable-renderer:fullscreen .lsp-mdtable-scroll { overflow: auto; }
          .lsp-mdtable-renderer:fullscreen table.lsp-mdt {
            width: 100% !important; min-width: max-content;
          }
          .lsp-mdtable-renderer:fullscreen table.lsp-mdt th,
          .lsp-mdtable-renderer:fullscreen table.lsp-mdt td {
            padding: 8px 12px !important; font-size: 14px;
          }
          .lsp-mdtable-renderer:fullscreen .lsp-mdtable-text { font-size: 14px; }
          .lsp-mdt-menu {
            position: fixed; z-index: 2147483647; min-width: 168px;
            padding: 4px; border-radius: 6px;
            border: 1px solid var(--ls-border-color);
            background: var(--ls-secondary-background-color, #2b2b2b);
            color: var(--ls-primary-text-color);
            box-shadow: 0 6px 20px rgba(0,0,0,.35);
            font-size: 13px; user-select: none;
          }
          .lsp-mdt-menu-item {
            display: flex; align-items: center; gap: 8px;
            padding: 5px 10px; border-radius: 4px; cursor: pointer;
            white-space: nowrap;
          }
          .lsp-mdt-menu-icon {
            display: inline-flex; flex: 0 0 auto; line-height: 0;
            opacity: .8;
          }
          .lsp-mdt-menu-icon svg { display: block; }
          .lsp-mdt-menu-item:hover .lsp-mdt-menu-icon { opacity: 1; }
          .lsp-mdt-menu-item:hover {
            background: var(--ls-active-primary-color, #2563eb);
            color: #fff;
          }
          .lsp-mdt-menu-item.disabled {
            opacity: .4; cursor: default; pointer-events: none;
          }
          .lsp-mdt-menu-sep {
            height: 1px; margin: 4px 6px;
            background: var(--ls-border-color);
          }
          .lsp-mdt-toolbar {
            position: fixed; z-index: 2147483646;
            display: flex; align-items: center; gap: 2px;
            padding: 3px; border-radius: 6px;
            border: 1px solid var(--ls-border-color);
            background: var(--ls-secondary-background-color, #2b2b2b);
            box-shadow: 0 4px 14px rgba(0,0,0,.3);
            user-select: none;
          }
          .lsp-mdt-tb-btn {
            display: inline-flex; align-items: center; justify-content: center;
            width: 26px; height: 26px; padding: 0; line-height: 0;
            border: none; border-radius: 4px; cursor: pointer;
            background: transparent; color: var(--ls-primary-text-color);
          }
          .lsp-mdt-tb-btn svg { display: block; }
          .lsp-mdt-tb-btn:hover {
            background: var(--ls-active-primary-color, #2563eb); color: #fff;
          }
          .lsp-mdt-tb-btn.disabled {
            opacity: .35; cursor: default; pointer-events: none;
          }
          .lsp-mdt-tb-sep {
            width: 1px; align-self: stretch; margin: 2px 3px;
            background: var(--ls-border-color);
          }
          /* Edge drag-reorder: subtle always-on grip hint on the table's
             top edge (columns) and left edge (rows). */
          .lsp-mdtable-renderer table.lsp-mdt {
            box-shadow:
              inset 0 4px 0 -2px var(--ls-border-color),
              inset 4px 0 0 -2px var(--ls-border-color);
          }
          .lsp-mdtable-renderer.lsp-mdt-grab,
          .lsp-mdtable-renderer.lsp-mdt-grab table.lsp-mdt th,
          .lsp-mdtable-renderer.lsp-mdt-grab table.lsp-mdt td {
            cursor: grab !important;
          }
          /* Hover affordance: blue bar on the grabbable edge. */
          .lsp-mdtable-renderer table.lsp-mdt th.lsp-mdt-edge-col {
            box-shadow: inset 0 3px 0 0 var(--ls-active-primary-color, #2563eb) !important;
          }
          .lsp-mdtable-renderer table.lsp-mdt th.lsp-mdt-edge-row,
          .lsp-mdtable-renderer table.lsp-mdt td.lsp-mdt-edge-row {
            box-shadow: inset 3px 0 0 0 var(--ls-active-primary-color, #2563eb) !important;
          }
          .lsp-mdtable-renderer.lsp-mdt-dragging,
          .lsp-mdtable-renderer.lsp-mdt-dragging * {
            cursor: grabbing !important; user-select: none !important;
          }
        `)

        logseq.Experiments.registerBlockRenderer('markdown-table-view', {
          includeChildren: false,
          priority: 10,
          when: ({ content, format }) =>
            (format === undefined || format === 'markdown') &&
            looksLikeMarkdownTable(content),
          render: ({ uuid, blockId, content }) => {
            const React = logseq.Experiments.React
            const id = uuid || blockId
            const src = content || ''
            const segments = splitStrByTable(src, parseMarkdownTable(src))
            const children = segments.map((seg, si) => {
              if (seg.type !== 'table') {
                return seg.str
                  ? React.createElement('div',
                      { key: 's' + si, className: 'lsp-mdtable-text' }, seg.str)
                  : null
              }
              const matrix = markdownTableToMatrix(seg.str)
              const [head = [], ...body] = matrix
              // Inline styles beat Logseq's higher-specificity prose/table
              // rules (which were overriding our class-based stylesheet).
              const cellStyle = { textAlign: 'left', verticalAlign: 'top', whiteSpace: 'pre' }
              return React.createElement('div',
                { key: 's' + si, className: 'lsp-mdtable-scroll' },
                React.createElement('table', { className: 'lsp-mdt' }, [
                  React.createElement('thead', { key: 'h' },
                    React.createElement('tr', null,
                      head.map((c, i) => React.createElement('th', { key: i, style: cellStyle }, c)))),
                  React.createElement('tbody', { key: 'b' },
                    body.map((row, ri) => React.createElement('tr', { key: ri },
                      head.map((_, ci) =>
                        React.createElement('td', { key: ci, style: cellStyle }, row[ci] ?? '')))))
                ]))
            })
            const editable = logseq.settings?.inlineEditable !== false
            const dbRaw = Number(logseq.settings?.inlineEditDebounceMs)
            const debounceMs = Number.isFinite(dbRaw) && dbRaw >= 0 ? dbRaw : 500
            return React.createElement('div',
              {
                className: 'lsp-mdtable-renderer',
                'data-blockid': String(id),
                ref: (el) => {
                  if (!el) return
                  prepareInlineRenderer(el)
                  if (editable) {
                    const inlineOpts = {
                      segments,
                      blockId: id,
                      updateBlock: (b, c) => logseqEditor.updateBlock(b, c),
                      debounceMs,
                      isPinned: () => logseq.settings?.toolbarPinned === true,
                      setPinned: (v) => { try { logseq.updateSettings({ toolbarPinned: !!v }) } catch (e) { /* noop */ } },
                      menuLabels: {
                        insertRowAbove: i18n.t('Insert row above'),
                        insertRowBelow: i18n.t('Insert row below'),
                        deleteRow: i18n.t('Delete row'),
                        insertColLeft: i18n.t('Insert column left'),
                        insertColRight: i18n.t('Insert column right'),
                        deleteCol: i18n.t('Delete column'),
                        moveRowUp: i18n.t('Move row up'),
                        moveRowDown: i18n.t('Move row down'),
                        moveColLeft: i18n.t('Move column left'),
                        moveColRight: i18n.t('Move column right'),
                        sortColAsc: i18n.t('Sort column ascending'),
                        sortColDesc: i18n.t('Sort column descending'),
                        pinToolbar: i18n.t('Pin toolbar'),
                        unpinToolbar: i18n.t('Unpin toolbar'),
                        fullScreen: i18n.t('Full screen'),
                        exitFullScreen: i18n.t('Exit full screen')
                      }
                    }
                    attachInlineEditing(el, inlineOpts)
                    resumePinnedToolbar(el, inlineOpts)
                  }
                }
              }, children)
          }
        })
      }

      // Monospace table source when editing: while a block whose raw content
      // is a markdown table is being edited, render its <textarea> in a
      // monospace font so "readable data"-aligned tables actually line up
      // (Logseq's source editor otherwise uses a proportional font).
      const monoEnabled = logseq.settings?.monospaceTableSource !== false
      if (monoEnabled) {
        const monoOffsetRaw = Number(logseq.settings?.monoFontSizeOffset)
        const monoOffset = Number.isFinite(monoOffsetRaw) ? monoOffsetRaw : -1
        const monoFontSize = monoOffset === 0
          ? '1em'
          : `calc(1em ${monoOffset < 0 ? '-' : '+'} ${Math.abs(monoOffset)}px)`
        logseq.provideStyle(`
          textarea.lsp-mdt-mono {
            font-family: 'Fira Code', Menlo, Monaco, Consolas, 'Courier New', monospace !important;
            font-size: ${monoFontSize} !important;
          }
        `)
        let hostDoc2 = null
        try { hostDoc2 = (window.top || window.parent)?.document } catch (e) { /* cross-origin */ }
        if (!hostDoc2) {
          console.warn('[mdtable] monospace table source: host document not accessible; skipped')
        } else {
          const applyMono = (el) => {
            if (!el || el.tagName !== 'TEXTAREA') return
            if (!el.closest('.editor-inner, .block-editor, .editor-wrapper, .ls-block')) return
            el.classList.toggle('lsp-mdt-mono', looksLikeMarkdownTable(el.value))
          }
          hostDoc2.addEventListener('focusin', (e) => applyMono(e.target), true)
          hostDoc2.addEventListener('input', (e) => applyMono(e.target), true)
        }
      }
    })
  })
}
