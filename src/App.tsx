import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './App.css'
import { exportScheduleToExcel } from './export/excelExport'
import { generateOneCourtSchedule } from './scheduler/generateOneCourtSchedule'
import { generateFourCourtSchedule } from './scheduler/generateFourCourtSchedule'
import { generateThreeCourtSchedule } from './scheduler/generateThreeCourtSchedule'
import { generateTwoCourtSchedule } from './scheduler/generateTwoCourtSchedule'
import { isAlwaysActiveTeamCount } from './scheduler/teamUtils'
import type {
  CourtId,
  CourtNumber,
  CourtVenueSetting,
  ScheduleGenerationResult,
  ScheduleSlot,
} from './scheduler/types'

const COURT_OPTIONS = [1, 2, 3, 4] as const
const ACTIVE_COURTS = ['A', 'B', 'C', 'D'] as const
const VENUE_CONFIGURABLE_COURTS = ['A', 'B', 'C', 'D'] as const
const VENUE_OPTIONS = ['会場1', '会場2'] as const
const X_PROFILE_URL = 'https://x.com/kumasansofttouc'
const X_SHARE_TEXT =
  'バレーボール練習試合の組み合わせ作成\n#バレーボール #練習試合 #組み合わせ作成 #スポ少 #小学生バレー'
const DEFAULT_COURT_VENUES: Record<CourtId, string> = {
  A: '会場1',
  B: '会場1',
  C: '会場1',
  D: '会場1',
}
const ROUND_PRESETS = [1, 2, 3, 4, 5] as const
const MAX_TEAM_COUNT = 32
const MIN_ROUND_COUNT = 1
const MAX_ROUND_COUNT = 10
const PRINT_RESTING_TEAM_NAME_LIMIT = 10

const MIN_TEAM_COUNT_BY_COURT: Record<CourtNumber, number> = {
  1: 2,
  2: 4,
  3: 6,
  4: 8,
}

const TEAM_PRESETS_BY_COURT: Record<CourtNumber, readonly number[]> = {
  1: [2, 3, 4, 5, 6],
  2: [4, 5, 6, 7, 8],
  3: [6, 7, 8, 9, 10],
  4: [8, 9, 10, 11, 12],
}

type MatchSetup = {
  courtCount: CourtNumber
  teamCount: number
  roundCount: number
  teamNames: string[]
  courtVenues: Record<CourtId, string>
}

type NumberSelectorProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  unit: string
  presets: readonly number[]
  description?: string
  onChange: (value: number) => void
}

type ScheduleResultViewProps = {
  result: ScheduleGenerationResult
  onBack: () => void
  onExportExcel: () => void
  isExcelExporting: boolean
  excelMessage: string | null
}

type CourtMatchDisplayProps = {
  slot: ScheduleSlot
  court: CourtId
}

type ResultActionsProps = {
  onBack: () => void
  onExportExcel: () => void
  isExcelExporting: boolean
}

type ScheduleTableColumnsProps = {
  courtCount: CourtNumber
  shouldShowRestingTeams: boolean
}

type MatchNumberCellProps = {
  slotNumber: number
}

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.min(Math.max(Math.floor(value), min), max)
}

const createEmptyTeamNames = (count: number) => Array.from({ length: count }, () => '')

const resizeTeamNames = (names: string[], count: number) =>
  Array.from({ length: count }, (_, index) => names[index] ?? '')

const getMinTeamCount = (courtCount: CourtNumber) => MIN_TEAM_COUNT_BY_COURT[courtCount]

const hasMultipleCourtVenues = (
  courtCount: CourtNumber,
  courtVenues: Record<CourtId, string>,
) =>
  new Set(
    ACTIVE_COURTS.slice(0, courtCount).map((court) => courtVenues[court]),
  ).size > 1

const formatRestingTeams = (slot: ScheduleSlot) => {
  if (slot.restingTeams.length === 0) {
    return 'なし'
  }

  return slot.restingTeams.map((team) => team.name).join('、')
}

const truncateTeamNameForPrint = (teamName: string) => {
  const characters = Array.from(teamName)

  if (characters.length <= PRINT_RESTING_TEAM_NAME_LIMIT) {
    return teamName
  }

  return characters.slice(0, PRINT_RESTING_TEAM_NAME_LIMIT).join("") + "…"
}

const formatPrintRestingTeams = (slot: ScheduleSlot) => {
  if (slot.restingTeams.length === 0) {
    return "なし"
  }

  return slot.restingTeams
    .map((team) => truncateTeamNameForPrint(team.name))
    .join("、")
}

const getCourtAssignment = (slot: ScheduleSlot, court: CourtId) =>
  slot.courts.find((assignment) => assignment.court === court)

const createCourtVenueSettings = (
  courtCount: CourtNumber,
  courtVenues: Record<CourtId, string>,
): CourtVenueSetting[] =>
  ACTIVE_COURTS.slice(0, courtCount).map((court) => ({
    court,
    venueName: courtVenues[court],
  }))

const formatCourtLabel = (result: ScheduleGenerationResult, court: CourtId) => {
  const venueName = result.courtVenues?.find((setting) => setting.court === court)?.venueName

  if ((result.courtCount === 3 || result.courtCount === 4) && venueName !== undefined) {
    return court + 'コート（' + venueName + '）'
  }

  return court + 'コート'
}

const hasAnyRestingTeams = (result: ScheduleGenerationResult) =>
  result.slots.some((slot) => slot.restingTeams.length > 0)

const getPrintPageClass = (result: ScheduleGenerationResult) =>
  result.courtCount >= 3 ? 'print-page-landscape' : 'print-page-portrait'

const getScheduleTableClassName = (
  courtCount: CourtNumber,
  shouldShowRestingTeams: boolean,
) =>
  "schedule-table schedule-table-courts-" +
  courtCount +
  (shouldShowRestingTeams ? " has-rest-column" : " no-rest-column")

const printSchedule = () => {
  window.print()
}

const createXShareUrl = () =>
  'https://x.com/intent/tweet?text=' +
  encodeURIComponent(X_SHARE_TEXT) +
  '&url=' +
  encodeURIComponent(window.location.href)

const waitForNextFrame = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })

function NumberSelector({
  id,
  label,
  value,
  min,
  max,
  unit,
  presets,
  description,
  onChange,
}: NumberSelectorProps) {
  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(clampNumber(Number(event.target.value), min, max))
  }

  return (
    <div className="field-group">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="number-field">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          onChange={handleInputChange}
        />
        <span>{unit}</span>
      </div>
      {description && <p className="field-help">{description}</p>}
      <div className="preset-group" aria-label={label + 'の候補'}>
        {presets.map((preset) => (
          <button
            className={preset === value ? 'preset-button selected' : 'preset-button'}
            key={preset}
            type="button"
            aria-pressed={preset === value}
            onClick={() => onChange(preset)}
          >
            {preset}{unit}
          </button>
        ))}
      </div>
    </div>
  )
}

function CourtMatchDisplay({ slot, court }: CourtMatchDisplayProps) {
  const assignment = getCourtAssignment(slot, court)

  if (assignment?.match === null || assignment === undefined) {
    return <span className="court-empty">空き</span>
  }

  return (
    <span className="match-card">
      <span className="match-teams">
        <span>{assignment.match.teamA.name}</span>
        <span className="versus">vs</span>
        <span>{assignment.match.teamB.name}</span>
      </span>
      <span className="score-space print-only" aria-hidden="true" />
    </span>
  )
}

function OneCourtMatchDisplay({ slot }: { slot: ScheduleSlot }) {
  const match = slot.courts[0]?.match

  if (match === undefined || match === null) {
    return <span className="court-empty">空き</span>
  }

  return (
    <span className="match-card">
      <span className="match-teams">
        <span>{match.teamA.name}</span>
        <span className="versus">vs</span>
        <span>{match.teamB.name}</span>
      </span>
      <span className="score-space print-only" aria-hidden="true" />
    </span>
  )
}

function ScheduleTableColumns({
  courtCount,
  shouldShowRestingTeams,
}: ScheduleTableColumnsProps) {
  return (
    <colgroup>
      <col className="match-number-column" />
      {ACTIVE_COURTS.slice(0, courtCount).map((court) => (
        <col className="court-column" key={court} />
      ))}
      {shouldShowRestingTeams && <col className="rest-column" />}
    </colgroup>
  )
}

function MatchNumberCell({ slotNumber }: MatchNumberCellProps) {
  return (
    <th className="match-number-cell" scope="row">
      <span className="screen-only">第{slotNumber}試合</span>
      <span className="print-match-number print-only" aria-hidden="true">
        {slotNumber}
      </span>
    </th>
  )
}

function RestingTeamsCell({ slot }: { slot: ScheduleSlot }) {
  return (
    <>
      <span className="screen-only">{formatRestingTeams(slot)}</span>
      <span className="print-resting-teams print-only" aria-hidden="true">
        {formatPrintRestingTeams(slot)}
      </span>
    </>
  )
}

function PrintScheduleHeader({ result }: { result: ScheduleGenerationResult }) {
  return (
    <div className="print-schedule-header print-only">
      <div>
        <p className="print-brand">kumasan soft touch</p>
        <h2>練習試合 組み合わせ表</h2>
      </div>
      <p className="print-summary">
        {result.courtCount}コート / {result.teams.length}チーム / {result.roundCount}周 / 全{result.totalMatches}対戦
      </p>
    </div>
  )
}

function ResultActions({
  onBack,
  onExportExcel,
  isExcelExporting,
}: ResultActionsProps) {
  return (
    <div className="result-actions screen-only">
      <div className="output-actions" aria-label="出力操作" aria-busy={isExcelExporting}>
        <button
          className="excel-button"
          type="button"
          disabled={isExcelExporting}
          onClick={onExportExcel}
        >
          {isExcelExporting ? 'Excel作成中…' : 'Excel出力'}
        </button>
        <button className="print-button" type="button" onClick={printSchedule}>
          印刷する
        </button>
      </div>
      <button className="secondary-button" type="button" onClick={onBack}>
        入力画面へ戻る
      </button>
    </div>
  )
}

function OneCourtScheduleResultView({
  result,
  onBack,
  onExportExcel,
  isExcelExporting,
  excelMessage,
}: ScheduleResultViewProps) {
  const shouldShowRestingTeams = hasAnyRestingTeams(result)

  return (
    <section className={'result-panel ' + getPrintPageClass(result)} aria-labelledby="schedule-title">
      <PrintScheduleHeader result={result} />
      <div className="result-heading">
        <div>
          <p className="result-kicker">1コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <ResultActions
          isExcelExporting={isExcelExporting}
          onBack={onBack}
          onExportExcel={onExportExcel}
        />
      </div>

      {excelMessage && (
        <p className="form-message result-message screen-only" role="alert">
          {excelMessage}
        </p>
      )}

      <div className="schedule-table-wrap">
        <table className={getScheduleTableClassName(result.courtCount, shouldShowRestingTeams)}>
          <ScheduleTableColumns
            courtCount={result.courtCount}
            shouldShowRestingTeams={shouldShowRestingTeams}
          />
          <thead>
            <tr>
              <th className="match-number-heading" scope="col">
                <span className="screen-only">試合順</span>
              </th>
              <th scope="col">対戦</th>
              {shouldShowRestingTeams && <th className="rest-heading" scope="col">休憩チーム</th>}
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <MatchNumberCell slotNumber={slot.slotNumber} />
                <td data-label="対戦">
                  <OneCourtMatchDisplay slot={slot} />
                </td>
                {shouldShowRestingTeams && (
                  <td className="rest-cell" data-label="休憩チーム">
                    <RestingTeamsCell slot={slot} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TwoCourtScheduleResultView({
  result,
  onBack,
  onExportExcel,
  isExcelExporting,
  excelMessage,
}: ScheduleResultViewProps) {
  const shouldShowRestingTeams = hasAnyRestingTeams(result)

  return (
    <section className={'result-panel ' + getPrintPageClass(result)} aria-labelledby="schedule-title">
      <PrintScheduleHeader result={result} />
      <div className="result-heading">
        <div>
          <p className="result-kicker">2コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <ResultActions
          isExcelExporting={isExcelExporting}
          onBack={onBack}
          onExportExcel={onExportExcel}
        />
      </div>

      {excelMessage && (
        <p className="form-message result-message screen-only" role="alert">
          {excelMessage}
        </p>
      )}

      <div className="schedule-table-wrap">
        <table className={getScheduleTableClassName(result.courtCount, shouldShowRestingTeams)}>
          <ScheduleTableColumns
            courtCount={result.courtCount}
            shouldShowRestingTeams={shouldShowRestingTeams}
          />
          <thead>
            <tr>
              <th className="match-number-heading" scope="col">
                <span className="screen-only">試合順</span>
              </th>
              <th scope="col">Aコート</th>
              <th scope="col">Bコート</th>
              {shouldShowRestingTeams && <th className="rest-heading" scope="col">休憩チーム</th>}
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <MatchNumberCell slotNumber={slot.slotNumber} />
                <td data-label="Aコート">
                  <CourtMatchDisplay slot={slot} court="A" />
                </td>
                <td data-label="Bコート">
                  <CourtMatchDisplay slot={slot} court="B" />
                </td>
                {shouldShowRestingTeams && (
                  <td className="rest-cell" data-label="休憩チーム">
                    <RestingTeamsCell slot={slot} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MultiCourtScheduleResultView({
  result,
  onBack,
  onExportExcel,
  isExcelExporting,
  excelMessage,
}: ScheduleResultViewProps) {
  const courts = ACTIVE_COURTS.slice(0, result.courtCount)
  const shouldShowRestingTeams = hasAnyRestingTeams(result)

  return (
    <section className={'result-panel ' + getPrintPageClass(result)} aria-labelledby="schedule-title">
      <PrintScheduleHeader result={result} />
      <div className="result-heading">
        <div>
          <p className="result-kicker">{result.courtCount}コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <ResultActions
          isExcelExporting={isExcelExporting}
          onBack={onBack}
          onExportExcel={onExportExcel}
        />
      </div>

      {excelMessage && (
        <p className="form-message result-message screen-only" role="alert">
          {excelMessage}
        </p>
      )}

      <div className="schedule-table-wrap">
        <table
          className={
            getScheduleTableClassName(result.courtCount, shouldShowRestingTeams) +
            " multi-court-schedule-table"
          }
        >
          <ScheduleTableColumns
            courtCount={result.courtCount}
            shouldShowRestingTeams={shouldShowRestingTeams}
          />
          <thead>
            <tr>
              <th className="match-number-heading" scope="col">
                <span className="screen-only">試合順</span>
              </th>
              {courts.map((court) => (
                <th scope="col" key={court}>{formatCourtLabel(result, court)}</th>
              ))}
              {shouldShowRestingTeams && <th className="rest-heading" scope="col">休憩チーム</th>}
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <MatchNumberCell slotNumber={slot.slotNumber} />
                {courts.map((court) => (
                  <td data-label={formatCourtLabel(result, court)} key={court}>
                    <CourtMatchDisplay slot={slot} court={court} />
                  </td>
                ))}
                {shouldShowRestingTeams && (
                  <td className="rest-cell" data-label="休憩チーム">
                    <RestingTeamsCell slot={slot} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ScheduleResultView({
  result,
  onBack,
  onExportExcel,
  isExcelExporting,
  excelMessage,
}: ScheduleResultViewProps) {
  const resultViewProps = {
    result,
    onBack,
    onExportExcel,
    isExcelExporting,
    excelMessage,
  }

  if (result.courtCount === 1) {
    return <OneCourtScheduleResultView {...resultViewProps} />
  }

  if (result.courtCount === 3 || result.courtCount === 4) {
    return <MultiCourtScheduleResultView {...resultViewProps} />
  }

  return <TwoCourtScheduleResultView {...resultViewProps} />
}

function App() {
  const [setup, setSetup] = useState<MatchSetup>(() => ({
    courtCount: 2,
    teamCount: 6,
    roundCount: 3,
    teamNames: createEmptyTeamNames(6),
    courtVenues: DEFAULT_COURT_VENUES,
  }))
  const [scheduleResult, setScheduleResult] = useState<ScheduleGenerationResult | null>(null)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [excelMessage, setExcelMessage] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isExcelExporting, setIsExcelExporting] = useState(false)

  const enteredTeamCount = useMemo(
    () => setup.teamNames.filter((teamName) => teamName.trim().length > 0).length,
    [setup.teamNames],
  )

  const minTeamCount = getMinTeamCount(setup.courtCount)
  const teamPresets = TEAM_PRESETS_BY_COURT[setup.courtCount]
  const shouldShowVenueMoveNote =
    isAlwaysActiveTeamCount(setup.courtCount, setup.teamCount) &&
    hasMultipleCourtVenues(setup.courtCount, setup.courtVenues)

  const updateTeamCount = (teamCount: number) => {
    setSetup((current) => {
      const nextTeamCount = clampNumber(
        teamCount,
        getMinTeamCount(current.courtCount),
        MAX_TEAM_COUNT,
      )

      return {
        ...current,
        teamCount: nextTeamCount,
        teamNames: resizeTeamNames(current.teamNames, nextTeamCount),
      }
    })
  }

  const updateRoundCount = (roundCount: number) => {
    setSetup((current) => ({
      ...current,
      roundCount: clampNumber(roundCount, MIN_ROUND_COUNT, MAX_ROUND_COUNT),
    }))
  }

  const updateTeamName = (index: number, value: string) => {
    setSetup((current) => ({
      ...current,
      teamNames: current.teamNames.map((teamName, teamIndex) =>
        teamIndex === index ? value : teamName,
      ),
    }))
  }

  const updateCourtVenue = (court: CourtId, venueName: string) => {
    setSetup((current) => ({
      ...current,
      courtVenues: {
        ...current.courtVenues,
        [court]: venueName,
      },
    }))
  }

  const handleCourtChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextCourtCount = Number(event.target.value) as CourtNumber

    setSetup((current) => {
      const nextMinTeamCount = getMinTeamCount(nextCourtCount)
      const nextTeamCount = Math.max(current.teamCount, nextMinTeamCount)

      return {
        ...current,
        courtCount: nextCourtCount,
        teamCount: nextTeamCount,
        teamNames: resizeTeamNames(current.teamNames, nextTeamCount),
      }
    })
  }

  const generateSchedule = (currentSetup: MatchSetup) => {
    try {
      let nextSchedule: ScheduleGenerationResult

      if (currentSetup.courtCount === 1) {
        nextSchedule = generateOneCourtSchedule({
          courtCount: currentSetup.courtCount,
          roundCount: currentSetup.roundCount,
          teamNames: currentSetup.teamNames,
        })
      } else if (currentSetup.courtCount === 2) {
        nextSchedule = generateTwoCourtSchedule({
          courtCount: currentSetup.courtCount,
          roundCount: currentSetup.roundCount,
          teamNames: currentSetup.teamNames,
        })
      } else if (currentSetup.courtCount === 3) {
        nextSchedule = generateThreeCourtSchedule({
          courtCount: currentSetup.courtCount,
          roundCount: currentSetup.roundCount,
          teamNames: currentSetup.teamNames,
          courtVenues: createCourtVenueSettings(currentSetup.courtCount, currentSetup.courtVenues),
        })
      } else {
        nextSchedule = generateFourCourtSchedule({
          courtCount: currentSetup.courtCount,
          roundCount: currentSetup.roundCount,
          teamNames: currentSetup.teamNames,
          courtVenues: createCourtVenueSettings(currentSetup.courtCount, currentSetup.courtVenues),
        })
      }

      setFormMessage(null)
      setExcelMessage(null)
      setScheduleResult(nextSchedule)
    } catch (error) {
      setScheduleResult(null)
      setFormMessage(error instanceof Error ? error.message : '組み合わせを作成できませんでした。')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isGenerating) {
      return
    }

    const currentSetup = setup
    setFormMessage(null)
    setIsGenerating(true)
    window.requestAnimationFrame(() => {
      window.setTimeout(() => generateSchedule(currentSetup), 0)
    })
  }

  const handleExcelExport = async () => {
    if (scheduleResult === null || isExcelExporting) {
      return
    }

    setExcelMessage(null)
    setIsExcelExporting(true)

    try {
      await waitForNextFrame()
      await exportScheduleToExcel(scheduleResult)
    } catch (error) {
      console.error('Excel export failed', error)
      setExcelMessage('Excelファイルを作成できませんでした。もう一度お試しください。')
    } finally {
      setIsExcelExporting(false)
    }
  }

  const handleBackToForm = () => {
    setScheduleResult(null)
    setFormMessage(null)
    setExcelMessage(null)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <p className="brand">kumasan soft touch</p>
        </div>
      </header>

      <main className="app-main">
        <section className="title-section" aria-labelledby="page-title">
          <p className="eyebrow">小・中・高校の練習試合に</p>
          <h1 id="page-title">練習試合 組み合わせ作成</h1>
          <p className="lead">ログインなしですぐ使えます。コート数、チーム数、周回数を入力して準備を始めます。</p>
          <div className="alpha-note screen-only">
            <span>α版</span>
            <p>現在α版です。生成結果は利用前にご確認ください。</p>
          </div>
        </section>

        {scheduleResult ? (
          <ScheduleResultView
            excelMessage={excelMessage}
            isExcelExporting={isExcelExporting}
            result={scheduleResult}
            onBack={handleBackToForm}
            onExportExcel={handleExcelExport}
          />
        ) : (
          <form className="setup-panel" onSubmit={handleSubmit} aria-busy={isGenerating}>
            <section className="form-section" aria-labelledby="basic-settings-title">
              <div className="section-heading">
                <div>
                  <h2 id="basic-settings-title">基本設定</h2>
                  <p>コートと試合の規模を設定します。</p>
                </div>
                <p className="setup-summary">
                  {setup.courtCount}コート / {setup.teamCount}チーム / {setup.roundCount}周
                </p>
              </div>

              {formMessage && <p className="form-message">{formMessage}</p>}

              <div className="settings-grid">
                <div className="field-group">
                  <label className="field-label" htmlFor="court-count">
                    コート数
                  </label>
                  <div className="field-control">
                    <select
                      id="court-count"
                      value={setup.courtCount}
                      onChange={handleCourtChange}
                    >
                      {COURT_OPTIONS.map((courtCount) => (
                        <option key={courtCount} value={courtCount}>
                          {courtCount}コート
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <NumberSelector
                  id="team-count"
                  label="チーム数"
                  value={setup.teamCount}
                  min={minTeamCount}
                  max={MAX_TEAM_COUNT}
                  unit="チーム"
                  presets={teamPresets}
                  description={setup.courtCount + 'コートでは' + minTeamCount + 'チーム以上'}
                  onChange={updateTeamCount}
                />

                <NumberSelector
                  id="round-count"
                  label="周回数"
                  value={setup.roundCount}
                  min={MIN_ROUND_COUNT}
                  max={MAX_ROUND_COUNT}
                  unit="周"
                  presets={ROUND_PRESETS}
                  description="1周＝他の全チームと1回ずつ対戦"
                  onChange={updateRoundCount}
                />
              </div>

              {(setup.courtCount === 3 || setup.courtCount === 4) && (
                <div className="venue-settings" aria-labelledby="venue-settings-title">
                  <div className="venue-settings-heading">
                    <h3 id="venue-settings-title">会場設定</h3>
                    <p>{setup.courtCount}面が同じ会場なら、このまま使えます。</p>
                  </div>
                  {shouldShowVenueMoveNote && (
                    <p className="venue-note">
                      全チームが毎試合出場するため、複数会場を使用すると会場移動が多くなる場合があります。
                    </p>
                  )}
                  <div className="venue-grid">
                    {VENUE_CONFIGURABLE_COURTS.slice(0, setup.courtCount).map((court) => {
                      const selectId = 'venue-' + court

                      return (
                        <label className="venue-field" htmlFor={selectId} key={court}>
                          <span>{court}コート</span>
                          <select
                            id={selectId}
                            value={setup.courtVenues[court]}
                            onChange={(changeEvent) => updateCourtVenue(court, changeEvent.target.value)}
                          >
                            {VENUE_OPTIONS.map((venueName) => (
                              <option key={venueName} value={venueName}>
                                {venueName}
                              </option>
                            ))}
                          </select>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>

            <section className="form-section" aria-labelledby="team-names-title">
              <div className="section-heading">
                <div>
                  <h2 id="team-names-title">チーム名</h2>
                  <p>チーム数に合わせて入力欄が増減します。</p>
                </div>
                <p className="setup-summary">
                  {enteredTeamCount} / {setup.teamCount} 入力済み
                </p>
              </div>

              <div className="team-grid">
                {setup.teamNames.map((teamName, index) => {
                  const teamNumber = index + 1
                  const inputId = 'team-name-' + String(teamNumber)

                  return (
                    <label className="team-field" htmlFor={inputId} key={inputId}>
                      <span>チーム {teamNumber}</span>
                      <input
                        id={inputId}
                        type="text"
                        value={teamName}
                        placeholder={'例：' + String(teamNumber) + '組'}
                        autoComplete="off"
                        onChange={(changeEvent) => updateTeamName(index, changeEvent.target.value)}
                      />
                    </label>
                  )
                })}
              </div>
            </section>

            <div className="form-actions">
              {isGenerating && (
                <p className="loading-message" role="status" aria-live="polite">
                  組み合わせを作成中です。
                </p>
              )}
              <button className="primary-button" type="submit" disabled={isGenerating}>
                {isGenerating && <span className="button-spinner" aria-hidden="true" />}
                <span>{isGenerating ? '作成中…' : '組み合わせを作成'}</span>
              </button>
            </div>
          </form>
        )}
        <footer className="app-footer screen-only">
          <span>
            ご意見・不具合報告：
            <a href={X_PROFILE_URL} target="_blank" rel="noreferrer">kumasansofttouch</a>
          </span>
          <a className="share-link" href={createXShareUrl()} target="_blank" rel="noreferrer">
            Xで共有
          </a>
        </footer>
      </main>
    </div>
  )
}

export default App
