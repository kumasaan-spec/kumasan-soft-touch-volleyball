import type {
  CourtId,
  CourtNumber,
  ScheduleGenerationResult,
  ScheduleMatch,
  ScheduleSlot,
} from '../scheduler/types'

const COURTS: CourtId[] = ['A', 'B', 'C', 'D']
const SHEET_NAME = '組み合わせ'
const MATCH_HEADER_ROW = 5
const FIRST_MATCH_ROW = 6
const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const SCORE_SPACE = '（　　　－　　　）'
const MAX_SHEET_NAME_LENGTH = 31
const DOLLAR_SIGN = String.fromCharCode(36)
const MATCH_HEADER_STYLE_ID = 4
const MERGED_HEADER_START_STYLE_ID = 11
const MERGED_HEADER_MIDDLE_STYLE_ID = 12
const MERGED_HEADER_END_STYLE_ID = 13

type CellValue = string | number

type WorksheetCell = {
  column: number
  row: number
  value?: CellValue
  styleId?: number
}

type MergeRange = {
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
}

type ColumnLayout = {
  width: number
}

type ZipEntry = {
  name: string
  content: Uint8Array
}

type CourtColumnBlock = {
  court: CourtId
  startColumn: number
  teamAColumn: number
  versusColumn: number
  teamBColumn: number
  scoreColumn: number
  endColumn: number
}

type WorksheetModel = {
  cells: WorksheetCell[]
  columnLayouts: ColumnLayout[]
  mergeRanges: MergeRange[]
  maxColumn: number
  maxRow: number
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const columnName = (column: number) => {
  let nextColumn = column
  let name = ''

  while (nextColumn > 0) {
    const remainder = (nextColumn - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    nextColumn = Math.floor((nextColumn - 1) / 26)
  }

  return name
}

const cellReference = (column: number, row: number) => columnName(column) + row

const rangeReference = ({ startColumn, startRow, endColumn, endRow }: MergeRange) =>
  cellReference(startColumn, startRow) + ':' + cellReference(endColumn, endRow)

const hasAnyRestingTeams = (result: ScheduleGenerationResult) =>
  result.slots.some((slot) => slot.restingTeams.length > 0)

const formatRestingTeams = (slot: ScheduleSlot) => {
  if (slot.restingTeams.length === 0) {
    return 'なし'
  }

  return slot.restingTeams.map((team) => team.name).join('、')
}

const formatCourtLabel = (result: ScheduleGenerationResult, court: CourtId) => {
  const venueName = result.courtVenues?.find((setting) => setting.court === court)?.venueName

  if ((result.courtCount === 3 || result.courtCount === 4) && venueName !== undefined) {
    return court + 'コート（' + venueName + '）'
  }

  return court + 'コート'
}

export const createScheduleExcelFileName = (result: ScheduleGenerationResult) =>
  [
    'kumasan-soft-touch',
    result.courtCount + 'court',
    result.teams.length + 'teams',
    result.roundCount + 'rounds',
  ]
    .join('_')
    .replaceAll(String.fromCharCode(92), '-')
    .replace(/[/:*?"<>|]/g, '-') + '.xlsx'

const getTeamColumnWidth = (courtCount: CourtNumber) => {
  if (courtCount === 1) {
    return 24
  }

  if (courtCount === 2) {
    return 16
  }

  if (courtCount === 3) {
    return 14
  }

  return 12
}

const getScoreColumnWidth = (courtCount: CourtNumber) => (courtCount >= 3 ? 11 : 12)

const createCourtBlocks = (courtCount: CourtNumber) => {
  const courtBlocks: CourtColumnBlock[] = []
  let column = 2

  for (const court of COURTS.slice(0, courtCount)) {
    courtBlocks.push({
      court,
      startColumn: column,
      teamAColumn: column,
      versusColumn: column + 1,
      teamBColumn: column + 2,
      scoreColumn: column + 3,
      endColumn: column + 3,
    })
    column += 4
  }

  return courtBlocks
}

const getMatchForCourt = (slot: ScheduleSlot, court: CourtId) =>
  slot.courts.find((assignment) => assignment.court === court)?.match ?? null

const pushTextCell = (
  cells: WorksheetCell[],
  row: number,
  column: number,
  value: string,
  styleId: number,
) => {
  cells.push({ row, column, value, styleId })
}

const pushNumberCell = (
  cells: WorksheetCell[],
  row: number,
  column: number,
  value: number,
  styleId: number,
) => {
  cells.push({ row, column, value, styleId })
}

const pushStyleCell = (cells: WorksheetCell[], row: number, column: number, styleId: number) => {
  cells.push({ row, column, styleId })
}

const addMergedCourtHeaderCells = (
  cells: WorksheetCell[],
  row: number,
  block: CourtColumnBlock,
  label: string,
) => {
  pushTextCell(cells, row, block.startColumn, label, MERGED_HEADER_START_STYLE_ID)

  for (let column = block.startColumn + 1; column <= block.endColumn; column += 1) {
    pushStyleCell(
      cells,
      row,
      column,
      column === block.endColumn ? MERGED_HEADER_END_STYLE_ID : MERGED_HEADER_MIDDLE_STYLE_ID,
    )
  }
}

const addMatchCells = (
  cells: WorksheetCell[],
  row: number,
  block: CourtColumnBlock,
  match: ScheduleMatch | null,
) => {
  if (match === null) {
    pushTextCell(cells, row, block.teamAColumn, '空き', 8)
    pushTextCell(cells, row, block.versusColumn, '', 7)
    pushTextCell(cells, row, block.teamBColumn, '', 8)
    pushTextCell(cells, row, block.scoreColumn, '', 9)
    return
  }

  pushTextCell(cells, row, block.teamAColumn, match.teamA.name, 8)
  pushTextCell(cells, row, block.versusColumn, 'vs', 7)
  pushTextCell(cells, row, block.teamBColumn, match.teamB.name, 8)
  pushTextCell(cells, row, block.scoreColumn, SCORE_SPACE, 9)
}

const createWorksheetModel = (result: ScheduleGenerationResult): WorksheetModel => {
  const cells: WorksheetCell[] = []
  const courtBlocks = createCourtBlocks(result.courtCount)
  const hasResting = hasAnyRestingTeams(result)
  const restColumn = hasResting ? courtBlocks[courtBlocks.length - 1].endColumn + 1 : null
  const maxColumn = restColumn ?? courtBlocks[courtBlocks.length - 1].endColumn
  const maxRow = FIRST_MATCH_ROW + result.slots.length - 1
  const mergeRanges: MergeRange[] = [
    { startColumn: 1, startRow: 1, endColumn: maxColumn, endRow: 1 },
    { startColumn: 1, startRow: 2, endColumn: maxColumn, endRow: 2 },
    { startColumn: 1, startRow: 3, endColumn: maxColumn, endRow: 3 },
  ]

  pushTextCell(cells, 1, 1, 'kumasan soft touch', 1)
  pushTextCell(cells, 2, 1, '練習試合 組み合わせ表', 2)
  pushTextCell(
    cells,
    3,
    1,
    result.courtCount +
      'コート / ' +
      result.teams.length +
      'チーム / ' +
      result.roundCount +
      '周 / 全' +
      result.totalMatches +
      '対戦',
    3,
  )

  pushTextCell(cells, MATCH_HEADER_ROW, 1, '試合', MATCH_HEADER_STYLE_ID)
  for (const block of courtBlocks) {
    addMergedCourtHeaderCells(cells, MATCH_HEADER_ROW, block, formatCourtLabel(result, block.court))
    mergeRanges.push({
      startColumn: block.startColumn,
      startRow: MATCH_HEADER_ROW,
      endColumn: block.endColumn,
      endRow: MATCH_HEADER_ROW,
    })
  }

  if (restColumn !== null) {
    pushTextCell(cells, MATCH_HEADER_ROW, restColumn, '休憩チーム', MATCH_HEADER_STYLE_ID)
  }

  for (const slot of result.slots) {
    const row = FIRST_MATCH_ROW + slot.slotNumber - 1
    pushNumberCell(cells, row, 1, slot.slotNumber, 5)

    for (const block of courtBlocks) {
      addMatchCells(cells, row, block, getMatchForCourt(slot, block.court))
    }

    if (restColumn !== null) {
      pushTextCell(cells, row, restColumn, formatRestingTeams(slot), 10)
    }
  }

  const teamWidth = getTeamColumnWidth(result.courtCount)
  const scoreWidth = getScoreColumnWidth(result.courtCount)
  const columnLayouts: ColumnLayout[] = [{ width: 5 }]

  for (let index = 0; index < courtBlocks.length; index += 1) {
    columnLayouts.push(
      { width: teamWidth },
      { width: 4 },
      { width: teamWidth },
      { width: scoreWidth },
    )
  }

  if (restColumn !== null) {
    columnLayouts.push({ width: 16 })
  }

  return {
    cells,
    columnLayouts,
    mergeRanges,
    maxColumn,
    maxRow,
  }
}

const createCellXml = ({ column, row, value, styleId = 0 }: WorksheetCell) => {
  const reference = cellReference(column, row)
  const style = styleId > 0 ? ' s="' + styleId + '"' : ''

  if (value === undefined) {
    return '<c r="' + reference + '"' + style + '/>'
  }

  if (typeof value === 'number') {
    return '<c r="' + reference + '"' + style + '><v>' + value + '</v></c>'
  }

  return (
    '<c r="' +
    reference +
    '" t="inlineStr"' +
    style +
    '><is><t xml:space="preserve">' +
    escapeXml(value) +
    '</t></is></c>'
  )
}

const createWorksheetXml = (result: ScheduleGenerationResult, model: WorksheetModel) => {
  const cellsByRow = new Map<number, WorksheetCell[]>()
  const orientation = result.courtCount >= 3 ? 'landscape' : 'portrait'
  const rows: string[] = []

  for (const cell of model.cells) {
    const rowCells = cellsByRow.get(cell.row) ?? []
    rowCells.push(cell)
    cellsByRow.set(cell.row, rowCells)
  }

  for (let row = 1; row <= model.maxRow; row += 1) {
    const height = row === 2 ? 24 : row >= FIRST_MATCH_ROW ? 28 : 18
    const cells = (cellsByRow.get(row) ?? [])
      .sort((a, b) => a.column - b.column)
      .map(createCellXml)
      .join('')

    rows.push('<row r="' + row + '" ht="' + height + '" customHeight="1">' + cells + '</row>')
  }

  const columnsXml = model.columnLayouts
    .map((layout, index) => {
      const column = index + 1
      return (
        '<col min="' +
        column +
        '" max="' +
        column +
        '" width="' +
        layout.width +
        '" customWidth="1"/>'
      )
    })
    .join('')

  const mergeXml = model.mergeRanges.length
    ? '<mergeCells count="' +
      model.mergeRanges.length +
      '">' +
      model.mergeRanges.map((range) => '<mergeCell ref="' + rangeReference(range) + '"/>').join('') +
      '</mergeCells>'
    : ''

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:' +
    cellReference(model.maxColumn, model.maxRow) +
    '"/>' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="' +
    MATCH_HEADER_ROW +
    '" topLeftCell="A' +
    FIRST_MATCH_ROW +
    '" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A' +
    FIRST_MATCH_ROW +
    '" sqref="A' +
    FIRST_MATCH_ROW +
    '"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="18"/>' +
    '<cols>' +
    columnsXml +
    '</cols>' +
    '<sheetData>' +
    rows.join('') +
    '</sheetData>' +
    mergeXml +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.25" right="0.25" top="0.45" bottom="0.45" header="0.2" footer="0.2"/>' +
    '<pageSetup paperSize="9" orientation="' +
    orientation +
    '" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>'
  )
}

const createWorkbookXml = (model: WorksheetModel) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="' +
  escapeXml(SHEET_NAME.slice(0, MAX_SHEET_NAME_LENGTH)) +
  '" sheetId="1" r:id="rId1"/></sheets>' +
  '<definedNames>' +
  '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'' +
  escapeXml(SHEET_NAME) +
  '\'!' +
  DOLLAR_SIGN +
  MATCH_HEADER_ROW +
  ':' +
  DOLLAR_SIGN +
  MATCH_HEADER_ROW +
  '</definedName>' +
  '<definedName name="_xlnm.Print_Area" localSheetId="0">\'' +
  escapeXml(SHEET_NAME) +
  '\'!' +
  DOLLAR_SIGN +
  'A' +
  DOLLAR_SIGN +
  '1:' +
  DOLLAR_SIGN +
  columnName(model.maxColumn) +
  DOLLAR_SIGN +
  model.maxRow +
  '</definedName>' +
  '</definedNames>' +
  '</workbook>'

const createWorkbookRelsXml = () =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

const createRootRelsXml = () =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>'

const createContentTypesXml = () =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>'

const createStylesXml = () =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="4">' +
  '<font><sz val="11"/><name val="Yu Gothic"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FF13745F"/><name val="Yu Gothic"/></font>' +
  '<font><b/><sz val="16"/><name val="Yu Gothic"/></font>' +
  '<font><b/><sz val="11"/><name val="Yu Gothic"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF4F0"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="5">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border>' +
  '<left style="thin"><color rgb="FF333333"/></left>' +
  '<right style="thin"><color rgb="FF333333"/></right>' +
  '<top style="thin"><color rgb="FF333333"/></top>' +
  '<bottom style="thin"><color rgb="FF333333"/></bottom>' +
  '<diagonal/>' +
  '</border>' +
  '<border>' +
  '<left style="thin"><color rgb="FF333333"/></left>' +
  '<right/>' +
  '<top style="thin"><color rgb="FF333333"/></top>' +
  '<bottom style="thin"><color rgb="FF333333"/></bottom>' +
  '<diagonal/>' +
  '</border>' +
  '<border>' +
  '<left/>' +
  '<right/>' +
  '<top style="thin"><color rgb="FF333333"/></top>' +
  '<bottom style="thin"><color rgb="FF333333"/></bottom>' +
  '<diagonal/>' +
  '</border>' +
  '<border>' +
  '<left/>' +
  '<right style="thin"><color rgb="FF333333"/></right>' +
  '<top style="thin"><color rgb="FF333333"/></top>' +
  '<bottom style="thin"><color rgb="FF333333"/></bottom>' +
  '<diagonal/>' +
  '</border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="14">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment horizontal="right"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="4" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

const createCoreXml = () => {
  const createdAt = new Date().toISOString()

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>練習試合 組み合わせ表</dc:title>' +
    '<dc:creator>kumasan soft touch</dc:creator>' +
    '<cp:lastModifiedBy>kumasan soft touch</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' +
    createdAt +
    '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' +
    createdAt +
    '</dcterms:modified>' +
    '</cp:coreProperties>'
  )
}

const createAppXml = () =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Application>kumasan soft touch</Application>' +
  '</Properties>'

const stringToBytes = (value: string) => new TextEncoder().encode(value)

const createCrcTable = () => {
  const table = new Uint32Array(256)

  for (let index = 0; index < table.length; index += 1) {
    let value = index

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }

    table[index] = value >>> 0
  }

  return table
}

const CRC_TABLE = createCrcTable()

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff

  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

const writeUint16 = (view: DataView, offset: number, value: number) => {
  view.setUint16(offset, value, true)
}

const writeUint32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value, true)
}

const concatBytes = (parts: Uint8Array[]) => {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const bytes = new Uint8Array(length)
  let offset = 0

  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }

  return bytes
}

const createZip = (entries: ZipEntry[]) => {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const nameBytes = stringToBytes(entry.name)
    const entryCrc = crc32(entry.content)
    const localHeader = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(localHeader.buffer)

    writeUint32(localView, 0, 0x04034b50)
    writeUint16(localView, 4, 20)
    writeUint16(localView, 6, 0x0800)
    writeUint16(localView, 8, 0)
    writeUint16(localView, 10, 0)
    writeUint16(localView, 12, 0)
    writeUint32(localView, 14, entryCrc)
    writeUint32(localView, 18, entry.content.length)
    writeUint32(localView, 22, entry.content.length)
    writeUint16(localView, 26, nameBytes.length)
    writeUint16(localView, 28, 0)
    localHeader.set(nameBytes, 30)

    localParts.push(localHeader, entry.content)

    const centralHeader = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    writeUint32(centralView, 0, 0x02014b50)
    writeUint16(centralView, 4, 20)
    writeUint16(centralView, 6, 20)
    writeUint16(centralView, 8, 0x0800)
    writeUint16(centralView, 10, 0)
    writeUint16(centralView, 12, 0)
    writeUint16(centralView, 14, 0)
    writeUint32(centralView, 16, entryCrc)
    writeUint32(centralView, 20, entry.content.length)
    writeUint32(centralView, 24, entry.content.length)
    writeUint16(centralView, 28, nameBytes.length)
    writeUint16(centralView, 30, 0)
    writeUint16(centralView, 32, 0)
    writeUint16(centralView, 34, 0)
    writeUint16(centralView, 36, 0)
    writeUint32(centralView, 38, 0)
    writeUint32(centralView, 42, localOffset)
    centralHeader.set(nameBytes, 46)

    centralParts.push(centralHeader)
    localOffset += localHeader.length + entry.content.length
  }

  const centralDirectory = concatBytes(centralParts)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)
  writeUint32(endView, 0, 0x06054b50)
  writeUint16(endView, 4, 0)
  writeUint16(endView, 6, 0)
  writeUint16(endView, 8, entries.length)
  writeUint16(endView, 10, entries.length)
  writeUint32(endView, 12, centralDirectory.length)
  writeUint32(endView, 16, localOffset)
  writeUint16(endView, 20, 0)

  return concatBytes([...localParts, centralDirectory, endRecord])
}

export const createScheduleWorkbookBlob = (result: ScheduleGenerationResult) => {
  const model = createWorksheetModel(result)
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', content: stringToBytes(createContentTypesXml()) },
    { name: '_rels/.rels', content: stringToBytes(createRootRelsXml()) },
    { name: 'docProps/app.xml', content: stringToBytes(createAppXml()) },
    { name: 'docProps/core.xml', content: stringToBytes(createCoreXml()) },
    { name: 'xl/workbook.xml', content: stringToBytes(createWorkbookXml(model)) },
    { name: 'xl/_rels/workbook.xml.rels', content: stringToBytes(createWorkbookRelsXml()) },
    { name: 'xl/styles.xml', content: stringToBytes(createStylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', content: stringToBytes(createWorksheetXml(result, model)) },
  ]

  return new Blob([createZip(entries)], { type: XLSX_MIME_TYPE })
}

export const exportScheduleToExcel = async (result: ScheduleGenerationResult) => {
  const blob = createScheduleWorkbookBlob(result)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  try {
    link.href = url
    link.download = createScheduleExcelFileName(result)
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(url)
  }
}
