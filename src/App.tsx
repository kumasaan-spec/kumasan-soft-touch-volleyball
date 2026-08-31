import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import './App.css'

const COURT_OPTIONS = [1, 2, 3, 4] as const
const ROUND_PRESETS = [1, 2, 3, 4, 5] as const
const MAX_TEAM_COUNT = 32
const MIN_ROUND_COUNT = 1
const MAX_ROUND_COUNT = 10

type CourtCount = (typeof COURT_OPTIONS)[number]

const MIN_TEAM_COUNT_BY_COURT: Record<CourtCount, number> = {
  1: 2,
  2: 4,
  3: 6,
  4: 8,
}

const TEAM_PRESETS_BY_COURT: Record<CourtCount, readonly number[]> = {
  1: [2, 3, 4, 5, 6],
  2: [4, 5, 6, 7, 8],
  3: [6, 7, 8, 9, 10],
  4: [8, 9, 10, 11, 12],
}

type MatchSetup = {
  courtCount: CourtCount
  teamCount: number
  roundCount: number
  teamNames: string[]
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

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.min(Math.max(Math.floor(value), min), max)
}

const createEmptyTeamNames = (count: number) => Array.from({ length: count }, () => '')

const resizeTeamNames = (names: string[], count: number) =>
  Array.from({ length: count }, (_, index) => names[index] ?? '')

const getMinTeamCount = (courtCount: CourtCount) => MIN_TEAM_COUNT_BY_COURT[courtCount]

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

function App() {
  const [setup, setSetup] = useState<MatchSetup>(() => ({
    courtCount: 2,
    teamCount: 6,
    roundCount: 3,
    teamNames: createEmptyTeamNames(6),
  }))

  const enteredTeamCount = useMemo(
    () => setup.teamNames.filter((teamName) => teamName.trim().length > 0).length,
    [setup.teamNames],
  )

  const minTeamCount = getMinTeamCount(setup.courtCount)
  const teamPresets = TEAM_PRESETS_BY_COURT[setup.courtCount]

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

  const handleCourtChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextCourtCount = Number(event.target.value) as CourtCount

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
                const inputId = 'team-name-' + teamNumber

                return (
                  <label className="team-field" htmlFor={inputId} key={inputId}>
                    <span>チーム {teamNumber}</span>
                    <input
                      id={inputId}
                      type="text"
                      value={teamName}
                      placeholder={'例：' + teamNumber + '組'}
                      autoComplete="off"
                      onChange={(event) => updateTeamName(index, event.target.value)}
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
      </main>
    </div>
  )
}

export default App
