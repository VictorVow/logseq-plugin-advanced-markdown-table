import '@logseq/libs'
import React from 'react'
import ReactDOM from 'react-dom'
import 'antd/dist/antd.css'

import App from './pages/App'
import parseMarkdownTable from './utils/parseRawInputByMarkdownIt'
import { splitStrByTable } from './utils/splitStrByTable'
import { looksLikeMarkdownTable, markdownTableToMatrix } from './utils/detectMarkdownTable'
// import { multipleTables, empty, longTables, onlyText, tableWithTextBeforeAndAfter } from './utils/testExample'
import { longTables } from './utils/testExample'
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
    key: 'keyboardShortcut',
    type: 'string',
    default: 'mod+shift+t',
    title: 'Keyboard Shortcut',
    description: 'Keyboard shortcut to open the table editor. Use "mod" for Cmd (Mac) or Ctrl (Windows/Linux). Examples: mod+shift+t, ctrl+alt+t, mod+e'
  },
  {
    key: 'enableInlineRenderer',
    type: 'boolean',
    default: true,
    title: 'Inline table rendering',
    description: "Render markdown-table blocks inline as tables (replacing Logseq's native outline view), with an Edit button. Requires a Logseq version that supports the experimental block renderer API; ignored on older versions. Reload the plugin after changing this."
  },
  {
    key: 'nativeTableEditButton',
    type: 'boolean',
    default: true,
    title: 'Native table edit button',
    description: "Show an \"Edit Markdown Table\" button (top-left, on hover) over Logseq's natively-rendered markdown tables; clicking opens the table editor. Reload the plugin after changing this."
  }
]

const bootEditor = (input, blockId) => {
  console.log('[faiz:] === Raw Input: \n', input)
  let tables = parseMarkdownTable(input)
  console.log('[faiz:] === markdownIt parse res', tables)
  renderApp(input, tables, blockId)
}

if (isInBrowser) {
  applyTheme(window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  bootEditor(longTables, 111)
} else {
  logseq.useSettingsSchema(settingsSchema)

  logseq.ready().then(() => {
    logseq.App.getUserConfigs().then(configs => {
      i18n.changeLanguage(configs.preferredLanguage || 'en')
      applyTheme(configs.preferredThemeMode)
      if (typeof logseq.App.onThemeModeChanged === 'function') {
        logseq.App.onThemeModeChanged(({ mode }) => applyTheme(mode))
      }
      // padding-left: var(--ls-left-sidebar-width);
      logseq.provideStyle(`
        iframe#logseq-markdown-table.lsp-iframe-sandbox {
          z-index: 10;
        }
      `)
      console.log('[faiz:] === markdown-table-editor-plugin loaded')
      const commandCallback = (e) => {
        console.log('[faiz:] === woz-markdown-table-editor', e)
        logseqEditor.getBlock(e.uuid).then(block => {
          console.log('[faiz:] === block', block)
          // @logseq/libs 0.3.3: block.content is deprecated in favour of block.title
          const content = block.content ?? block.title ?? ''
          // only support markdown (treat missing format as ok — DB-graph blocks may omit it)
          if (block.format && block.format !== 'markdown') return logseq.UI.showMsg(i18n.t('Markdown table editor only support markdown'), 'warning')

          bootEditor(content, e.uuid)

          // for empty block
          // todo: fix
          // if (content === '') return renderApp(DEFAULT_TABLE, [], e.uuid)

          // const tables = parseMarkdownTable(content)
          // if (tables?.length > 0) {
          //   // const [startLine, endLine] = tables[0]
          //   // const firstTable = content.split('\n').slice(startLine, endLine).join('\n')
          //   // console.log('[faiz:] === firstTable', content, firstTable, startLine, endLine)
          //   // return renderApp(firstTable, e.uuid)
          //   return renderApp(content, tables, e.uuid)
          // }

          // const renderHtml = md.render(content)
          // if (renderHtml.startsWith('<table>') && (renderHtml.endsWith('</table>') || renderHtml.endsWith('</table>\n'))) {
          //   return renderApp(content || DEFAULT_TABLE, e.uuid)
          // }
          // format to table error
          // window.logseq.App.showMsg('Sorry, block content format to markdown table error', 'warning')
          // console.log('[faiz:] === block content format to markdown table error')
        })
      }

      const shortcutHandler = async () => {
        const currentBlock = await logseqEditor.getCurrentBlock()
        if (currentBlock) {
          commandCallback({ uuid: currentBlock.uuid })
        } else {
          logseq.UI.showMsg(i18n.t('Please select a block first'), 'warning')
        }
      }

      logseqEditor.registerBlockContextMenuItem(i18n.t('Markdown Table Editor'), commandCallback)
      logseqEditor.registerSlashCommand('Markdown Table Editor', commandCallback)

      // Inline block renderer: replace Logseq's native view for markdown-table
      // blocks with a read-only table + Edit button. Host-mounted via the
      // experimental Experiments API; a clean no-op on older Logseq hosts.
      const inlineEnabled = logseq.settings?.enableInlineRenderer !== false
      const hasBlockRenderer = typeof logseq.Experiments?.registerBlockRenderer === 'function'
      if (inlineEnabled && hasBlockRenderer) {
        logseq.provideStyle(`
          .lsp-mdtable-renderer { margin: 4px 0; max-width: 100%; }
          .lsp-mdtable-renderer .lsp-mdtable-scroll {
            display: block; width: 100%; max-width: 100%;
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
          .lsp-mdtable-renderer .lsp-mdtable-edit {
            margin-top: 6px; padding: 2px 10px; font-size: 12px; cursor: pointer;
            border: 1px solid var(--ls-border-color); border-radius: 4px;
            background: var(--ls-tertiary-background-color);
            color: var(--ls-primary-text-color);
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
            children.push(React.createElement('button', {
              key: 'edit',
              className: 'lsp-mdtable-edit',
              onClick: () => commandCallback({ uuid: id }) // existing modal flow
            }, i18n.t('Edit table')))
            return React.createElement('div',
              { className: 'lsp-mdtable-renderer' }, children)
          }
        })
      }

      // Native table edit button: overlay a hover "Edit Markdown Table"
      // button on Logseq's natively-rendered markdown tables (host DOM).
      const nativeBtnEnabled = logseq.settings?.nativeTableEditButton !== false
      if (nativeBtnEnabled) {
        logseq.provideStyle(`
          .markdown-table { position: relative; }
          .markdown-table .lsp-native-edit-btn {
            position: absolute; top: 4px; left: 4px; z-index: 5;
            opacity: 0; pointer-events: none; transition: opacity .12s;
            display: inline-flex; align-items: center; justify-content: center;
            padding: 4px; line-height: 0; cursor: pointer;
            border: 1px solid var(--ls-border-color); border-radius: 4px;
            background: var(--ls-secondary-background-color);
            color: var(--ls-primary-text-color);
          }
          .markdown-table .lsp-native-edit-btn svg { display: block; }
          .markdown-table:hover .lsp-native-edit-btn { opacity: 1; pointer-events: auto; }
        `)

        let hostDoc = null
        try { hostDoc = (window.top || window.parent)?.document } catch (e) { /* cross-origin */ }
        if (!hostDoc) {
          console.warn('[mdtable] native edit button: host document not accessible; skipped')
        } else {
          const label = i18n.t('Edit Markdown Table')
          const decorate = () => {
            hostDoc.querySelectorAll('.markdown-table:not([data-lsp-edit])').forEach(wrap => {
              wrap.dataset.lspEdit = '1'
              const btn = hostDoc.createElement('button')
              btn.className = 'lsp-native-edit-btn'
              btn.type = 'button'
              btn.title = label
              btn.setAttribute('aria-label', label)
              btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>'
              btn.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation()
                const blk = wrap.closest('.ls-block')
                const uuid = blk && blk.getAttribute('blockid')
                if (uuid) commandCallback({ uuid })
                else logseq.UI.showMsg(i18n.t('uuid error'), 'warning')
              })
              wrap.prepend(btn)
            })
          }
          decorate()
          let scheduled = false
          const obs = new MutationObserver(() => {
            if (scheduled) return
            scheduled = true
            ;(hostDoc.defaultView || window).requestAnimationFrame(() => {
              scheduled = false
              decorate()
            })
          })
          obs.observe(hostDoc.body, { childList: true, subtree: true })
        }
      }

      // Register keyboard shortcut from settings
      const shortcut = logseq.settings?.keyboardShortcut || 'mod+shift+t'
      logseq.App.registerCommandShortcut(
        { binding: shortcut },
        shortcutHandler
      )

      logseq.on('ui:visible:changed', (e) => {
        if (!e.visible) {
          ReactDOM.unmountComponentAtNode(document.getElementById('root'));
        }
      });
    })
  })
}

function renderApp(content, tables, blockId) {
  ReactDOM.render(
    <React.StrictMode>
      <App content={content} tables={tables} blockId={blockId} />
    </React.StrictMode>,
    document.getElementById('root')
  )
  if (!isInBrowser) logseq.showMainUI()
}
