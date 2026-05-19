import { tableLineReg } from './contants'

const genTable = (arr, startLine, endLine) => {
  return arr
    .slice(startLine, endLine)
    // 暂行逻辑，看是否可以优化： 无空行隔开的两个table，认为是一个 table，且过滤掉不符合 table 语法的内容
    .filter(str => tableLineReg.test(str))
    .join('\n')
}

export const splitStrByTable = (str, tables = []) => {
  const strToArr = str.split('\n')
  let strArrByTable = []

  tables.forEach((table, index, arr) => {
    const [startLine, endLine] = table
    const preEndLine = index === 0 ? 0 : arr[index - 1][1]

    if (startLine === preEndLine) {
      strArrByTable.push({
        str: genTable(strToArr, startLine, endLine),
        type: 'table',
      })
    } else {
      strArrByTable.push({
        str: strToArr.slice(preEndLine, startLine).join('\n'),
        type: 'notTable',
      })
      strArrByTable.push({
        // str: strToArr.slice(startLine, endLine).join('\n'),
        str: genTable(strToArr, startLine, endLine),
        type: 'table',
      })
    }

  })

  const [/*lastTableStartLine*/, lastTableEndLine] = tables[tables.length - 1]
  if (strToArr.length - 1 >= lastTableEndLine) {
    strArrByTable.push({
      str: strToArr.slice(lastTableEndLine).join('\n'),
      type: 'notTable'
    })
  }

  return strArrByTable
}
