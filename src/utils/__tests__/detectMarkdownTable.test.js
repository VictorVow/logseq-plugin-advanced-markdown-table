import { looksLikeMarkdownTable, markdownTableToMatrix } from '../detectMarkdownTable'
import {
  empty,
  onlyText,
  onlyOneTable,
  tableWithTextBefore,
  tableWithTextBeforeAndAfter,
  multipleTables,
  longTables,
} from '../testExample'

describe('looksLikeMarkdownTable', () => {
  it('detects blocks that contain a markdown table', () => {
    expect(looksLikeMarkdownTable(onlyOneTable)).toBe(true)
    expect(looksLikeMarkdownTable(tableWithTextBefore)).toBe(true)
    expect(looksLikeMarkdownTable(tableWithTextBeforeAndAfter)).toBe(true)
    expect(looksLikeMarkdownTable(multipleTables)).toBe(true)
    expect(looksLikeMarkdownTable(longTables)).toBe(true)
  })

  it('returns false for non-table content', () => {
    expect(looksLikeMarkdownTable(empty)).toBe(false)
    expect(looksLikeMarkdownTable(onlyText)).toBe(false)
    expect(looksLikeMarkdownTable(null)).toBe(false)
    expect(looksLikeMarkdownTable(undefined)).toBe(false)
    // a lone pipe line without a delimiter row is not a table
    expect(looksLikeMarkdownTable('|just|pipes|\nno delimiter here')).toBe(false)
  })

  it('accepts alignment colons in the delimiter row', () => {
    expect(looksLikeMarkdownTable('| a | b |\n| :-- | --: |\n| 1 | 2 |')).toBe(true)
  })
})

describe('markdownTableToMatrix', () => {
  it('splits header + body and drops the delimiter row', () => {
    expect(markdownTableToMatrix(onlyOneTable)).toEqual([
      ['title1', 'title2'],
      ['content1', 'content2'],
    ])
  })

  it('converts [:br] placeholders back to newlines', () => {
    expect(markdownTableToMatrix('|a[:br]b|c|\n|--|--|\n|d|e|')).toEqual([
      ['a\nb', 'c'],
      ['d', 'e'],
    ])
  })
})
