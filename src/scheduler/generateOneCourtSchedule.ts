import { createCardKey, createRoundRobinPairs } from './roundRobin'
import { normalizeTeamNames } from './teamUtils'
import type {
  CourtAssignment,
  ScheduleGenerationInput,
  ScheduleGenerationResult,
  ScheduleMatch,
  ScheduleSlot,
  Team,
} from './types'

const CANDIDATE_WINDOW_SIZE = 128

type PendingMatch = {
  id: string
  teamAIndex: number
  teamBIndex: number
  cardKey: string
  repeatIndex: number
  sequence: number
}

type TeamScheduleState = {
  played: number
  restCount: number
  currentPlayStreak: number
  currentRestStreak: number
}

const createPendingMatches = (teamCount: number, roundCount: number): PendingMatch[] => {
  const oneRoundPairs = createRoundRobinPairs(teamCount)
  const pendingMatches: PendingMatch[] = []

  for (let repeatIndex = 0; repeatIndex < roundCount; repeatIndex += 1) {
    oneRoundPairs.forEach(([teamAIndex, teamBIndex], pairIndex) => {
      const sequence = repeatIndex * oneRoundPairs.length + pairIndex
      const cardKey = createCardKey(teamAIndex, teamBIndex)

      pendingMatches.push({
        id: 'match-' + String(repeatIndex + 1) + '-' + String(pairIndex + 1),
        teamAIndex,
        teamBIndex,
        cardKey,
        repeatIndex,
        sequence,
      })
    })
  }

  return pendingMatches
}

const createTeamStates = (teamCount: number): TeamScheduleState[] =>
  Array.from({ length: teamCount }, () => ({
    played: 0,
    restCount: 0,
    currentPlayStreak: 0,
    currentRestStreak: 0,
  }))

const calculateSpread = (values: number[]) => Math.max(...values) - Math.min(...values)

const createScheduleMatch = (match: PendingMatch, teams: Team[]): ScheduleMatch => ({
  id: match.id,
  teamA: teams[match.teamAIndex],
  teamB: teams[match.teamBIndex],
  cardKey: match.cardKey,
})

const scoreCardInterval = (
  match: PendingMatch,
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  teamCount: number,
) => {
  const lastSlot = lastCardSlots.get(match.cardKey)

  if (lastSlot === undefined) {
    return 0
  }

  const gap = slotNumber - lastSlot
  const uniqueCardCount = (teamCount * (teamCount - 1)) / 2
  const preferredGap = Math.min(uniqueCardCount, Math.max(3, teamCount + 2))

  if (gap <= 1) {
    return 10_000
  }

  if (gap < preferredGap) {
    const closeRepeatPenalty = (preferredGap - gap) * 2_200
    const veryClosePenalty = gap <= 2 ? 3_000 : 0

    return closeRepeatPenalty + veryClosePenalty
  }

  return Math.max(0, preferredGap + 2 - gap) * 80
}

const scoreMatch = (
  match: PendingMatch,
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  const playingTeamIndexes = new Set([match.teamAIndex, match.teamBIndex])
  const nextPlayedCounts = teamStates.map((state, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? state.played + 1 : state.played,
  )
  const nextRestCounts = teamStates.map((state, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? state.restCount : state.restCount + 1,
  )

  let score = match.sequence * 0.001 + match.repeatIndex * 0.01
  score += scoreCardInterval(match, lastCardSlots, slotNumber, teamStates.length)
  score += calculateSpread(nextPlayedCounts) * 110
  score += calculateSpread(nextRestCounts) * 240

  teamStates.forEach((state, teamIndex) => {
    if (playingTeamIndexes.has(teamIndex)) {
      const nextPlayStreak = state.currentPlayStreak + 1

      if (nextPlayStreak >= 4) {
        score += 2_000 + (nextPlayStreak - 3) * 900
      } else if (nextPlayStreak === 3) {
        score += 520
      } else if (nextPlayStreak === 2) {
        score += 70
      }

      if (state.currentRestStreak > 0) {
        score -= Math.min(state.currentRestStreak, 3) * 120
      }

      score += state.played * 3
      return
    }

    const nextRestStreak = state.currentRestStreak + 1

    if (nextRestStreak >= 3) {
      score += 1_900 + (nextRestStreak - 2) * 900
    } else if (nextRestStreak === 2) {
      score += 900
    }

    if (state.currentPlayStreak >= 3) {
      score -= 420
    } else if (state.currentPlayStreak === 2) {
      score -= 220
    }

    score += (state.restCount + 1) * 18
  })

  return score
}

const selectNextMatchIndex = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  const candidateCount = Math.min(CANDIDATE_WINDOW_SIZE, pendingMatches.length)
  let selectedIndex = 0
  let selectedScore = Number.POSITIVE_INFINITY

  for (let index = 0; index < candidateCount; index += 1) {
    const score = scoreMatch(pendingMatches[index], teamStates, lastCardSlots, slotNumber)

    if (score < selectedScore) {
      selectedScore = score
      selectedIndex = index
    }
  }

  return selectedIndex
}

const applySlotToTeamStates = (
  match: PendingMatch,
  teamStates: TeamScheduleState[],
) => {
  const playingTeamIndexes = new Set([match.teamAIndex, match.teamBIndex])

  teamStates.forEach((state, teamIndex) => {
    if (playingTeamIndexes.has(teamIndex)) {
      state.played += 1
      state.currentPlayStreak += 1
      state.currentRestStreak = 0
      return
    }

    state.restCount += 1
    state.currentRestStreak += 1
    state.currentPlayStreak = 0
  })
}

export const generateOneCourtSchedule = ({
  courtCount,
  roundCount,
  teamNames,
}: ScheduleGenerationInput): ScheduleGenerationResult => {
  if (courtCount !== 1) {
    throw new Error('1コートの組み合わせ生成には、コート数を1にしてください。')
  }

  if (roundCount < 1) {
    throw new Error('周回数は1以上で指定してください。')
  }

  if (teamNames.length < 2) {
    throw new Error('1コートでは2チーム以上を指定してください。')
  }

  const teams = normalizeTeamNames(teamNames)
  const pendingMatches = createPendingMatches(teams.length, roundCount)
  const teamStates = createTeamStates(teams.length)
  const lastCardSlots = new Map<string, number>()
  const slots: ScheduleSlot[] = []

  while (pendingMatches.length > 0) {
    const slotNumber = slots.length + 1
    const selectedIndex = selectNextMatchIndex(
      pendingMatches,
      teamStates,
      lastCardSlots,
      slotNumber,
    )
    const [selectedMatch] = pendingMatches.splice(selectedIndex, 1)
    const courtAssignments: CourtAssignment[] = [
      {
        court: 'A',
        match: createScheduleMatch(selectedMatch, teams),
      },
    ]
    const playingTeamIndexes = new Set([selectedMatch.teamAIndex, selectedMatch.teamBIndex])
    const restingTeams = teams.filter((_, teamIndex) => !playingTeamIndexes.has(teamIndex))

    slots.push({
      slotNumber,
      courts: courtAssignments,
      restingTeams,
    })

    applySlotToTeamStates(selectedMatch, teamStates)
    lastCardSlots.set(selectedMatch.cardKey, slotNumber)
  }

  return {
    courtCount: 1,
    roundCount,
    teams,
    slots,
    totalMatches: slots.length,
  }
}
