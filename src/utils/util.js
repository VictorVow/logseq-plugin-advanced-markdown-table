import { DEFAULT_TABLE } from './contants'

export const stringToSlateValue = (str = '') => {
  str = str || DEFAULT_TABLE
  // 将 [:br] 转为换行符
  const _arr = str.trim().split('\n').filter(Boolean).map(_str => _str.replaceAll('[:br]', '\n'))
  const contentArr = [_arr[0]].concat(_arr.slice(2))
  const res = contentArr.map(rowStr => {
    const rowArr = rowStr.trim().split('|')
    return rowArr.slice(1, rowArr.length - 1)
  })
  return createTableNode(res)
}

export const slateValueToString = (slateVal) => {
  let rowStrs = Array.from(slateVal.children, (row) => {
    const cells = Array.from(row.children, (cell) => {
      // 将换行符替换为 [:br]
      return cell.children[0].text?.replaceAll('\n', '[:br]')
    }).join('|')
    return `|${cells}|`
  })
  // Default separator is unchanged ('--' per column). Only when the "readable"
  // action has space-framed the cells (" x ") do we size the separator dashes
  // to match, so the alignment applies solely to the table the user ran
  // "readable data" on — every other save serializes exactly as before.
  const sep = Array.from(slateVal.children[0].children, (cell) => {
    const s = String(cell.children[0].text ?? '').replaceAll('\n', '[:br]')
    if (s.length >= 4 && s.startsWith(' ') && s.endsWith(' ')) {
      return ` ${'-'.repeat(s.length - 2)} `
    }
    return '--'
  }).join('|')
  rowStrs.splice(1, 0, `|${sep}|`)
  return rowStrs.join('\n')
}

const createRow = (cellText) => {
  const newRow = Array.from(cellText, (value) => createTableCell(value))
  return {
    type: "table-row",
    children: newRow
  }
}

const createTableCell = (text) => {
  return {
    type: "table-cell",
    children: [{ text }]
  }
}

export const createTableNode = (cellText) => {
  const tableChildren = Array.from(cellText, (value) => createRow(value))
  let tableNode = { type: "table", children: tableChildren }
  return tableNode
}