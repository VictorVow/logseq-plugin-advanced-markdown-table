import { syncCellText } from '../inlineEditable'

const makeCell = (text) => {
  const el = document.createElement('td')
  el.textContent = text
  return el
}

describe('syncCellText', () => {
  it('no-ops when the live text already matches (echo re-render)', () => {
    const el = makeCell('hello')
    syncCellText(el, 'hello')
    expect(el.textContent).toBe('hello')
    // The original text node must be reused, not rebuilt — replacing it is
    // what resets the caret to the start of the cell.
    const textNodes = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
    expect(textNodes).toHaveLength(1)
    expect(textNodes[0].nodeValue).toBe('hello')
  })

  it('writes text into an empty cell', () => {
    const el = makeCell('')
    syncCellText(el, 'initial')
    expect(el.textContent).toBe('initial')
  })

  it('clears a cell when the new text is empty', () => {
    const el = makeCell('old')
    syncCellText(el, '')
    expect(el.textContent).toBe('')
  })

  it('overwrites genuinely different text (structural ops)', () => {
    const el = makeCell('old')
    syncCellText(el, 'new')
    expect(el.textContent).toBe('new')
  })

  it('survives null/undefined elements', () => {
    expect(() => syncCellText(null, 'x')).not.toThrow()
    expect(() => syncCellText(undefined, 'x')).not.toThrow()
  })
})
