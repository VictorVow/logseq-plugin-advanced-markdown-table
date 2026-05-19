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
          .lsp-mdtable-renderer { margin: 4px 0; }
          .lsp-mdtable-renderer table {
            border-collapse: collapse; width: 100%;
            color: var(--ls-primary-text-color);
          }
          .lsp-mdtable-renderer th, .lsp-mdtable-renderer td {
            border: 1px solid var(--ls-border-color); padding: 4px 8px;
            text-align: left; vertical-align: top; white-space: pre-wrap;
          }
          .lsp-mdtable-renderer th { background: var(--ls-secondary-background-color); }
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
              return React.createElement('table', { key: 's' + si }, [
                React.createElement('thead', { key: 'h' },
                  React.createElement('tr', null,
                    head.map((c, i) => React.createElement('th', { key: i }, c)))),
                React.createElement('tbody', { key: 'b' },
                  body.map((row, ri) => React.createElement('tr', { key: ri },
                    head.map((_, ci) =>
                      React.createElement('td', { key: ci }, row[ci] ?? '')))))
              ])
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
