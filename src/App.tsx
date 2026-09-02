import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './App.css'
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
}

type CourtMatchDisplayProps = {
  slot: ScheduleSlot
  court: CourtId
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
      <span>{assignment.match.teamA.name}</span>
      <span className="versus">vs</span>
      <span>{assignment.match.teamB.name}</span>
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
      <span>{match.teamA.name}</span>
      <span className="versus">vs</span>
      <span>{match.teamB.name}</span>
    </span>
  )
}

function OneCourtScheduleResultView({ result, onBack }: ScheduleResultViewProps) {
  return (
    <section className="result-panel" aria-labelledby="schedule-title">
      <div className="result-heading">
        <div>
          <p className="result-kicker">1コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={onBack}>
          入力画面へ戻る
        </button>
      </div>

      <div className="schedule-table-wrap">
        <table className="schedule-table">
          <thead>
            <tr>
              <th scope="col">試合順</th>
              <th scope="col">対戦</th>
              <th scope="col">休憩チーム</th>
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <th scope="row">第{slot.slotNumber}試合</th>
                <td data-label="対戦">
                  <OneCourtMatchDisplay slot={slot} />
                </td>
                <td data-label="休憩チーム">{formatRestingTeams(slot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TwoCourtScheduleResultView({ result, onBack }: ScheduleResultViewProps) {
  return (
    <section className="result-panel" aria-labelledby="schedule-title">
      <div className="result-heading">
        <div>
          <p className="result-kicker">2コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={onBack}>
          入力画面へ戻る
        </button>
      </div>

      <div className="schedule-table-wrap">
        <table className="schedule-table">
          <thead>
            <tr>
              <th scope="col">試合順</th>
              <th scope="col">Aコート</th>
              <th scope="col">Bコート</th>
              <th scope="col">休憩チーム</th>
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <th scope="row">第{slot.slotNumber}試合</th>
                <td data-label="Aコート">
                  <CourtMatchDisplay slot={slot} court="A" />
                </td>
                <td data-label="Bコート">
                  <CourtMatchDisplay slot={slot} court="B" />
                </td>
                <td data-label="休憩チーム">{formatRestingTeams(slot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MultiCourtScheduleResultView({ result, onBack }: ScheduleResultViewProps) {
  const courts = ACTIVE_COURTS.slice(0, result.courtCount)

  return (
    <section className="result-panel" aria-labelledby="schedule-title">
      <div className="result-heading">
        <div>
          <p className="result-kicker">{result.courtCount}コート版</p>
          <h2 id="schedule-title">生成結果</h2>
          <p>
            第1～第{result.slots.length}試合 / 全{result.totalMatches}対戦 /{' '}
            {result.teams.length}チーム / {result.roundCount}周
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={onBack}>
          入力画面へ戻る
        </button>
      </div>

      <div className="schedule-table-wrap">
        <table className="schedule-table multi-court-schedule-table">
          <thead>
            <tr>
              <th scope="col">試合順</th>
              {courts.map((court) => (
                <th scope="col" key={court}>{formatCourtLabel(result, court)}</th>
              ))}
              <th scope="col">休憩チーム</th>
            </tr>
          </thead>
          <tbody>
            {result.slots.map((slot) => (
              <tr key={slot.slotNumber}>
                <th scope="row">第{slot.slotNumber}試合</th>
                {courts.map((court) => (
                  <td data-label={formatCourtLabel(result, court)} key={court}>
                    <CourtMatchDisplay slot={slot} court={court} />
                  </td>
                ))}
                <td data-label="休憩チーム">{formatRestingTeams(slot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ScheduleResultView({ result, onBack }: ScheduleResultViewProps) {
  if (result.courtCount === 1) {
    return <OneCourtScheduleResultView result={result} onBack={onBack} />
  }

  if (result.courtCount === 3 || result.courtCount === 4) {
    return <MultiCourtScheduleResultView result={result} onBack={onBack} />
  }

  return <TwoCourtScheduleResultView result={result} onBack={onBack} />
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    try {
      let nextSchedule: ScheduleGenerationResult

      if (setup.courtCount === 1) {
        nextSchedule = generateOneCourtSchedule({
          courtCount: setup.courtCount,
          roundCount: setup.roundCount,
          teamNames: setup.teamNames,
        })
      } else if (setup.courtCount === 2) {
        nextSchedule = generateTwoCourtSchedule({
          courtCount: setup.courtCount,
          roundCount: setup.roundCount,
          teamNames: setup.teamNames,
        })
      } else if (setup.courtCount === 3) {
        nextSchedule = generateThreeCourtSchedule({
          courtCount: setup.courtCount,
          roundCount: setup.roundCount,
          teamNames: setup.teamNames,
          courtVenues: createCourtVenueSettings(setup.courtCount, setup.courtVenues),
        })
      } else {
        nextSchedule = generateFourCourtSchedule({
          courtCount: setup.courtCount,
          roundCount: setup.roundCount,
          teamNames: setup.teamNames,
          courtVenues: createCourtVenueSettings(setup.courtCount, setup.courtVenues),
        })
      }

      setFormMessage(null)
      setScheduleResult(nextSchedule)
    } catch (error) {
      setScheduleResult(null)
      setFormMessage(error instanceof Error ? error.message : '組み合わせを作成できませんでした。')
    }
  }

  const handleBackToForm = () => {
    setScheduleResult(null)
    setFormMessage(null)
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
        </section>

        {scheduleResult ? (
          <ScheduleResultView result={scheduleResult} onBack={handleBackToForm} />
        ) : (
          <form className="setup-panel" onSubmit={handleSubmit}>
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
              <button className="primary-button" type="submit">
                組み合わせを作成
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}

export default App
