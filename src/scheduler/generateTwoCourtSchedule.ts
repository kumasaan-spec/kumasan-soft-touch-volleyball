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

const CANDIDATE_WINDOW_SIZE = 96
const TWO_COURTS = ['A', 'B'] as const

type TwoCourtId = (typeof TWO_COURTS)[number]

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
  lastCourt: TwoCourtId | null
  courtCounts: Record<TwoCourtId, number>
}

type SelectedMatchIndexes = readonly [number] | readonly [number, number]

type CourtPlan = {
  selectedIndex: number
  court: TwoCourtId
}

type SlotPlan = {
  selectedIndexes: SelectedMatchIndexes
  courtPlans: CourtPlan[]
  score: number
}

const createPendingMatches = (teamCount: number, roundCount: number): PendingMatch[] => {
  const roundRobinPairs = createRoundRobinPairs(teamCount)
  const pendingMatches: PendingMatch[] = []
  let sequence = 0

  for (let repeatIndex = 0; repeatIndex < roundCount; repeatIndex += 1) {
    for (const [teamAIndex, teamBIndex] of roundRobinPairs) {
      pendingMatches.push({
        id: 'match-' + String(sequence + 1),
        teamAIndex,
        teamBIndex,
        cardKey: createCardKey(teamAIndex, teamBIndex),
        repeatIndex,
        sequence,
      })
      sequence += 1
    }
  }

  return pendingMatches
}

const createTeamStates = (teamCount: number): TeamScheduleState[] =>
  Array.from({ length: teamCount }, () => ({
    played: 0,
    restCount: 0,
    currentPlayStreak: 0,
    currentRestStreak: 0,
    lastCourt: null,
    courtCounts: {
      A: 0,
      B: 0,
    },
  }))

const hasTeamOverlap = (firstMatch: PendingMatch, secondMatch: PendingMatch) =>
  firstMatch.teamAIndex === secondMatch.teamAIndex ||
  firstMatch.teamAIndex === secondMatch.teamBIndex ||
  firstMatch.teamBIndex === secondMatch.teamAIndex ||
  firstMatch.teamBIndex === secondMatch.teamBIndex

const collectPlayingTeamIndexes = (matches: PendingMatch[]) => {
  const playingTeamIndexes = new Set<number>()

  for (const match of matches) {
    playingTeamIndexes.add(match.teamAIndex)
    playingTeamIndexes.add(match.teamBIndex)
  }

  return playingTeamIndexes
}

const getMatchTeamIndexes = (match: PendingMatch) => [match.teamAIndex, match.teamBIndex]

const calculateSpread = (values: number[]) => Math.max(...values) - Math.min(...values)

const scoreRestPlan = (
  selectedMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
) => {
  const playingTeamIndexes = collectPlayingTeamIndexes(selectedMatches)
  const nextRestCounts = teamStates.map((teamState, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? teamState.restCount : teamState.restCount + 1,
  )
  const nextPlayedCounts = teamStates.map((teamState, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? teamState.played + 1 : teamState.played,
  )
  const averageRestCount =
    nextRestCounts.reduce((total, restCount) => total + restCount, 0) / nextRestCounts.length
  let score = calculateSpread(nextRestCounts) * 720 + calculateSpread(nextPlayedCounts) * 120

  for (const [teamIndex, teamState] of teamStates.entries()) {
    const isPlaying = playingTeamIndexes.has(teamIndex)

    if (isPlaying) {
      if (teamState.currentRestStreak > 0) {
        score -= Math.min(teamState.currentRestStreak, 2) * 150
      }

      continue
    }

    const nextRestCount = teamState.restCount + 1
    const restDistanceFromAverage = nextRestCount - averageRestCount
    score += Math.max(0, restDistanceFromAverage) * 150
    score += nextRestCount * 18

    if (teamState.currentRestStreak > 0) {
      score += 9000 + teamState.currentRestStreak * 3500
    }

    if (teamState.currentPlayStreak >= 3) {
      score -= 220
    }
  }

  return score
}

const scorePlayStreaks = (
  selectedMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
) => {
  const playingTeamIndexes = collectPlayingTeamIndexes(selectedMatches)
  let score = 0

  for (const teamIndex of playingTeamIndexes) {
    const nextPlayStreak = teamStates[teamIndex].currentPlayStreak + 1

    if (nextPlayStreak >= 4) {
      score += 5200 + (nextPlayStreak - 4) * 2400
    } else if (nextPlayStreak === 3) {
      score += 520
    } else if (nextPlayStreak === 2) {
      score += 36
    }
  }

  return score
}

const scoreCardIntervals = (
  selectedMatches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  let score = 0

  for (const match of selectedMatches) {
    const lastCardSlot = lastCardSlots.get(match.cardKey)

    if (lastCardSlot === undefined) {
      continue
    }

    const gap = slotNumber - lastCardSlot

    if (gap <= 6) {
      score += (7 - gap) * 90
    }
  }

  return score
}

const scoreSequence = (selectedMatches: PendingMatch[]) =>
  selectedMatches.reduce(
    (total, match) => total + match.sequence * 0.001 + match.repeatIndex * 0.01,
    0,
  )

const scoreCourtForTeam = (
  teamState: TeamScheduleState,
  court: TwoCourtId,
) => {
  let score = 0

  if (teamState.lastCourt !== null) {
    const switchesCourt = teamState.lastCourt !== court

    if (switchesCourt && teamState.currentPlayStreak > 0) {
      score += 210 + teamState.currentPlayStreak * 80
    } else if (switchesCourt) {
      score += 36
    } else if (teamState.currentPlayStreak > 0) {
      score -= 58 + Math.min(teamState.currentPlayStreak, 3) * 22
    } else {
      score -= 12
    }
  }

  const nextACount = teamState.courtCounts.A + (court === 'A' ? 1 : 0)
  const nextBCount = teamState.courtCounts.B + (court === 'B' ? 1 : 0)
  const courtCountDifference = Math.abs(nextACount - nextBCount)

  if (courtCountDifference >= 5) {
    score += (courtCountDifference - 4) * 8
  }

  return score
}

const scoreCourtPlans = (
  selectedIndexes: SelectedMatchIndexes,
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
) => {
  const options: CourtPlan[][] = selectedIndexes.length === 1
    ? [
        [{ selectedIndex: selectedIndexes[0], court: 'A' }],
        [{ selectedIndex: selectedIndexes[0], court: 'B' }],
      ]
    : [
        [
          { selectedIndex: selectedIndexes[0], court: 'A' },
          { selectedIndex: selectedIndexes[1], court: 'B' },
        ],
        [
          { selectedIndex: selectedIndexes[0], court: 'B' },
          { selectedIndex: selectedIndexes[1], court: 'A' },
        ],
      ]

  let bestCourtPlans: CourtPlan[] = options[0]
  let bestScore = Number.POSITIVE_INFINITY

  for (const option of options) {
    let optionScore = 0

    for (const courtPlan of option) {
      const match = pendingMatches[courtPlan.selectedIndex]

      for (const teamIndex of getMatchTeamIndexes(match)) {
        optionScore += scoreCourtForTeam(teamStates[teamIndex], courtPlan.court)
      }
    }

    if (optionScore < bestScore) {
      bestScore = optionScore
      bestCourtPlans = option
    }
  }

  return {
    courtPlans: bestCourtPlans,
    score: bestScore,
  }
}

const scoreSlotPlan = (
  selectedIndexes: SelectedMatchIndexes,
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
): SlotPlan => {
  const selectedMatches = selectedIndexes.map((selectedIndex) => pendingMatches[selectedIndex])
  const courtPlanResult = scoreCourtPlans(selectedIndexes, pendingMatches, teamStates)
  const score =
    scoreRestPlan(selectedMatches, teamStates) +
    scorePlayStreaks(selectedMatches, teamStates) +
    scoreCardIntervals(selectedMatches, lastCardSlots, slotNumber) +
    courtPlanResult.score +
    scoreSequence(selectedMatches)

  return {
    selectedIndexes,
    courtPlans: courtPlanResult.courtPlans,
    score,
  }
}

const findFallbackPair = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  let bestPlan: SlotPlan | null = null

  for (let firstIndex = 0; firstIndex < pendingMatches.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < pendingMatches.length; secondIndex += 1) {
      if (hasTeamOverlap(pendingMatches[firstIndex], pendingMatches[secondIndex])) {
        continue
      }

      const plan = scoreSlotPlan(
        [firstIndex, secondIndex],
        pendingMatches,
        teamStates,
        lastCardSlots,
        slotNumber,
      )

      if (bestPlan === null || plan.score < bestPlan.score) {
        bestPlan = plan
      }
    }
  }

  return bestPlan
}

const chooseSingleMatch = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  const candidateCount = Math.min(CANDIDATE_WINDOW_SIZE, pendingMatches.length)
  let bestPlan = scoreSlotPlan([0], pendingMatches, teamStates, lastCardSlots, slotNumber)

  for (let index = 1; index < candidateCount; index += 1) {
    const plan = scoreSlotPlan([index], pendingMatches, teamStates, lastCardSlots, slotNumber)

    if (plan.score < bestPlan.score) {
      bestPlan = plan
    }
  }

  return bestPlan
}

const chooseMatchesForSlot = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
): SlotPlan => {
  if (pendingMatches.length === 1) {
    return scoreSlotPlan([0], pendingMatches, teamStates, lastCardSlots, slotNumber)
  }

  const candidateCount = Math.min(CANDIDATE_WINDOW_SIZE, pendingMatches.length)
  let bestPlan: SlotPlan | null = null

  for (let firstIndex = 0; firstIndex < candidateCount - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < candidateCount; secondIndex += 1) {
      if (hasTeamOverlap(pendingMatches[firstIndex], pendingMatches[secondIndex])) {
        continue
      }

      const plan = scoreSlotPlan(
        [firstIndex, secondIndex],
        pendingMatches,
        teamStates,
        lastCardSlots,
        slotNumber,
      )

      if (bestPlan === null || plan.score < bestPlan.score) {
        bestPlan = plan
      }
    }
  }

  if (bestPlan !== null) {
    return bestPlan
  }

  const fallbackPair = findFallbackPair(pendingMatches, teamStates, lastCardSlots, slotNumber)

  if (fallbackPair !== null) {
    return fallbackPair
  }

  return chooseSingleMatch(pendingMatches, teamStates, lastCardSlots, slotNumber)
}

const toScheduleMatch = (match: PendingMatch, teams: Team[]): ScheduleMatch => ({
  id: match.id,
  teamA: teams[match.teamAIndex],
  teamB: teams[match.teamBIndex],
  cardKey: match.cardKey,
})

const createEmptyAssignment = (court: TwoCourtId): CourtAssignment => ({
  court,
  match: null,
})

const buildCourtAssignments = (
  pendingMatches: PendingMatch[],
  courtPlans: CourtPlan[],
  teams: Team[],
): CourtAssignment[] =>
  TWO_COURTS.map((court) => {
    const courtPlan = courtPlans.find((plan) => plan.court === court)

    if (courtPlan === undefined) {
      return createEmptyAssignment(court)
    }

    return {
      court,
      match: toScheduleMatch(pendingMatches[courtPlan.selectedIndex], teams),
    }
  })

const updateScheduleState = (
  pendingMatches: PendingMatch[],
  selectedMatches: PendingMatch[],
  courtPlans: CourtPlan[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  const courtByTeamIndex = new Map<number, TwoCourtId>()

  for (const courtPlan of courtPlans) {
    const match = pendingMatches[courtPlan.selectedIndex]

    courtByTeamIndex.set(match.teamAIndex, courtPlan.court)
    courtByTeamIndex.set(match.teamBIndex, courtPlan.court)
  }

  for (const [teamIndex, teamState] of teamStates.entries()) {
    const court = courtByTeamIndex.get(teamIndex)

    if (court === undefined) {
      teamState.restCount += 1
      teamState.currentRestStreak += 1
      teamState.currentPlayStreak = 0
      continue
    }

    teamState.played += 1
    teamState.currentPlayStreak += 1
    teamState.currentRestStreak = 0
    teamState.lastCourt = court
    teamState.courtCounts[court] += 1
  }

  for (const match of selectedMatches) {
    lastCardSlots.set(match.cardKey, slotNumber)
  }
}

const removeSelectedMatches = (
  pendingMatches: PendingMatch[],
  selectedIndexes: SelectedMatchIndexes,
) => {
  const descendingIndexes = [...selectedIndexes].sort(
    (firstIndex, secondIndex) => secondIndex - firstIndex,
  )

  for (const selectedIndex of descendingIndexes) {
    pendingMatches.splice(selectedIndex, 1)
  }
}

export const generateTwoCourtSchedule = ({
  courtCount,
  roundCount,
  teamNames,
}: ScheduleGenerationInput): ScheduleGenerationResult => {
  if (courtCount !== 2) {
    throw new Error('現在2コート版を実装中です。')
  }

  if (teamNames.length < 4) {
    throw new Error('2コートでは4チーム以上を入力してください。')
  }

  if (!Number.isInteger(roundCount) || roundCount < 1) {
    throw new Error('周回数は1以上で入力してください。')
  }

  const teams = normalizeTeamNames(teamNames)
  const pendingMatches = createPendingMatches(teams.length, roundCount)
  const teamStates = createTeamStates(teams.length)
  const lastCardSlots = new Map<string, number>()
  const slots: ScheduleSlot[] = []
  let slotNumber = 1

  while (pendingMatches.length > 0) {
    const slotPlan = chooseMatchesForSlot(
      pendingMatches,
      teamStates,
      lastCardSlots,
      slotNumber,
    )
    const selectedMatches = slotPlan.selectedIndexes.map(
      (selectedIndex) => pendingMatches[selectedIndex],
    )
    const assignments = buildCourtAssignments(pendingMatches, slotPlan.courtPlans, teams)
    const playingTeamIndexes = collectPlayingTeamIndexes(selectedMatches)
    const restingTeams = teams.filter((_, teamIndex) => !playingTeamIndexes.has(teamIndex))

    slots.push({
      slotNumber,
      courts: assignments,
      restingTeams,
    })

    updateScheduleState(
      pendingMatches,
      selectedMatches,
      slotPlan.courtPlans,
      teamStates,
      lastCardSlots,
      slotNumber,
    )
    removeSelectedMatches(pendingMatches, slotPlan.selectedIndexes)
    slotNumber += 1
  }

  return {
    courtCount,
    roundCount,
    teams,
    slots,
    totalMatches: slots.reduce(
      (total, slot) => total + slot.courts.filter((court) => court.match !== null).length,
      0,
    ),
  }
}
