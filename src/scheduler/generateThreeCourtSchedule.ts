import { createCardKey, createRoundRobinPairs, createRoundRobinRounds } from './roundRobin'
import { isAlwaysActiveTeamCount, normalizeTeamNames } from './teamUtils'
import type {
  CourtAssignment,
  CourtVenueSetting,
  ScheduleGenerationInput,
  ScheduleGenerationResult,
  ScheduleMatch,
  ScheduleSlot,
  Team,
} from './types'

const CANDIDATE_WINDOW_SIZE = 64
const FALLBACK_WINDOW_SIZE = 180
const COMPLETION_SEARCH_LIMIT = 24
const TERMINAL_CARD_SCORE_WEIGHT = 1
const TERMINAL_CARD_SEARCH_LIMIT = 12
const ALWAYS_ACTIVE_COURT_STATE_LIMIT = 4096
const REST_LOCKED_RESCHEDULE_NODE_LIMIT = 120_000
const THREE_COURTS = ['A', 'B', 'C'] as const
const DEFAULT_VENUE_NAME = '会場1'

type ThreeCourtId = (typeof THREE_COURTS)[number]

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
  lastCourt: ThreeCourtId | null
  lastVenueName: string | null
  previousVenueName: string | null
  courtCounts: Record<ThreeCourtId, number>
  venueCounts: Record<string, number>
}

type CourtPlan = {
  selectedIndex: number
  court: ThreeCourtId
}

type CourtTeamIndexes = readonly [number, number]

type SlotPlan = {
  selectedIndexes: number[]
  courtPlans: CourtPlan[]
  score: number
}

type AlwaysActiveCourtState = {
  lastCourts: number[]
  lastVenues: number[]
  previousVenues: number[]
  teamCourtMoves: number[]
  teamVenueMoves: number[]
  teamVenueRoundTrips: number[]
  teamVenueUseCounts: number[][]
  lastCourtTeamIndexes: Array<CourtTeamIndexes | null>
  oneTeamChangeCount: number
  twoTeamChangeCount: number
  sameCourtCardRepeatCount: number
  orderScore: number
  courtPlanSlots: CourtPlan[][]
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
    lastVenueName: null,
    previousVenueName: null,
    courtCounts: {
      A: 0,
      B: 0,
      C: 0,
    },
    venueCounts: {},
  }))

const calculateSpread = (values: number[]) => Math.max(...values) - Math.min(...values)

const normalizeCourtVenues = (
  courtVenues: CourtVenueSetting[] | undefined,
): CourtVenueSetting[] =>
  THREE_COURTS.map((court) => {
    const configuredVenue = courtVenues?.find((setting) => setting.court === court)
    const venueName = configuredVenue?.venueName.trim() || DEFAULT_VENUE_NAME

    return {
      court,
      venueName,
    }
  })

const createVenueLookup = (courtVenues: CourtVenueSetting[]) => {
  const lookup = new Map<ThreeCourtId, string>()

  courtVenues.forEach((setting) => {
    if (setting.court === 'A' || setting.court === 'B' || setting.court === 'C') {
      lookup.set(setting.court, setting.venueName)
    }
  })

  return lookup
}

const getMatchTeamIndexes = (match: PendingMatch) => [match.teamAIndex, match.teamBIndex]

const hasTeamOverlap = (firstMatch: PendingMatch, secondMatch: PendingMatch) =>
  firstMatch.teamAIndex === secondMatch.teamAIndex ||
  firstMatch.teamAIndex === secondMatch.teamBIndex ||
  firstMatch.teamBIndex === secondMatch.teamAIndex ||
  firstMatch.teamBIndex === secondMatch.teamBIndex

const hasAnyTeamOverlap = (matches: PendingMatch[]) =>
  matches.some((match, matchIndex) =>
    matches.some(
      (otherMatch, otherMatchIndex) =>
        otherMatchIndex > matchIndex && hasTeamOverlap(match, otherMatch),
    ),
  )

const getCourtTeamIndexes = (match: PendingMatch): CourtTeamIndexes => [
  match.teamAIndex,
  match.teamBIndex,
]

const countSharedCourtTeams = (
  previousTeams: CourtTeamIndexes,
  nextTeams: CourtTeamIndexes,
) =>
  nextTeams.filter((teamIndex) => previousTeams.includes(teamIndex)).length

const scoreCourtTurnover = (
  previousTeams: CourtTeamIndexes | null | undefined,
  nextTeams: CourtTeamIndexes,
) => {
  if (previousTeams === null || previousTeams === undefined) {
    return 0
  }

  const sharedTeamCount = countSharedCourtTeams(previousTeams, nextTeams)

  if (sharedTeamCount === 2) {
    return 6_000
  }

  if (sharedTeamCount === 1) {
    return -8
  }

  return 26
}

const scoreCardRepeatGap = (gap: number, preferWideSpacing = false) => {
  if (preferWideSpacing) {
    if (gap <= 1) {
      return 24_000
    }

    if (gap === 2) {
      return 6_000
    }

    if (gap === 3) {
      return 1_200
    }

    if (gap <= 6) {
      return (7 - gap) * 160
    }

    return 0
  }

  if (gap <= 1) {
    return 4_500
  }

  if (gap === 2) {
    return 1_800
  }

  if (gap === 3) {
    return 900
  }

  if (gap <= 6) {
    return (7 - gap) * 120
  }

  return 0
}

const scoreCardIntervalsForMatches = (
  selectedMatches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  preferWideSpacing = false,
) => selectedMatches.reduce((score, match) => {
  const lastSlot = lastCardSlots.get(match.cardKey)
  if (lastSlot === undefined) {
    return score
  }

  return score + scoreCardRepeatGap(slotNumber - lastSlot, preferWideSpacing)
}, 0)

const hasImmediateCardRematch = (
  selectedMatches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) =>
  selectedMatches.some(
    (match) => lastCardSlots.get(match.cardKey) === slotNumber - 1,
  )

const createTerminalSlotCandidateIndexes = (
  matches: PendingMatch[],
  matchCount: number,
) => {
  const firstMatch = matches[0]
  if (!firstMatch) {
    return []
  }

  if (matchCount === 1) {
    return [[0]]
  }

  const candidates: number[][] = []

  const pickNext = (picked: number[], startIndex: number): void => {
    if (picked.length === matchCount) {
      candidates.push([...picked])
      return
    }

    for (let index = startIndex; index < matches.length; index += 1) {
      const nextMatch = matches[index]
      const pickedMatches = picked.map((pickedIndex) => matches[pickedIndex])
      if (hasAnyTeamOverlap([...pickedMatches, nextMatch])) {
        continue
      }

      pickNext([...picked, index], index + 1)
    }
  }

  pickNext([0], 1)
  return candidates
}

const createTerminalMemoKey = (
  matches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => {
  const cardState = matches
    .map((match) => `${match.cardKey}:${lastCardSlots.get(match.cardKey) ?? 0}`)
    .join('|')

  return `${slotNumber}::${matches.map((match) => match.id).join(',')}::${cardState}`
}

const findBestTerminalCardScore = (
  matches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  matchCount: number,
  forbidImmediateCardRematches: boolean,
  memo: Map<string, number | null>,
): number | null => {
  if (matches.length === 0) {
    return 0
  }

  const memoKey = createTerminalMemoKey(matches, lastCardSlots, slotNumber)
  if (memo.has(memoKey)) {
    return memo.get(memoKey) ?? null
  }

  let bestScore: number | null = null
  const candidateIndexes = createTerminalSlotCandidateIndexes(matches, matchCount)

  for (const indexes of candidateIndexes) {
    const selectedMatches = indexes.map((index) => matches[index])

    if (
      forbidImmediateCardRematches &&
      hasImmediateCardRematch(selectedMatches, lastCardSlots, slotNumber)
    ) {
      continue
    }

    const selectedIndexSet = new Set(indexes)
    const remainingMatches = matches.filter((_, index) => !selectedIndexSet.has(index))
    const nextLastCardSlots = new Map(lastCardSlots)

    for (const match of selectedMatches) {
      nextLastCardSlots.set(match.cardKey, slotNumber)
    }

    const futureScore = findBestTerminalCardScore(
      remainingMatches,
      nextLastCardSlots,
      slotNumber + 1,
      matchCount,
      forbidImmediateCardRematches,
      memo,
    )

    if (futureScore === null) {
      continue
    }

    const currentScore = scoreCardIntervalsForMatches(
      selectedMatches,
      lastCardSlots,
      slotNumber,
    ) + scoreSequence(selectedMatches) * 0.02

    const totalScore = currentScore + futureScore
    if (bestScore === null || totalScore < bestScore) {
      bestScore = totalScore
    }
  }

  memo.set(memoKey, bestScore)
  return bestScore
}

const scoreTerminalCardCompletionAfterSelection = (
  pendingMatches: PendingMatch[],
  selectedIndexes: number[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  matchCount: number,
  forbidImmediateCardRematches: boolean,
) => {
  const remainingMatchCount = pendingMatches.length - selectedIndexes.length
  if (remainingMatchCount === 0 || remainingMatchCount % matchCount !== 0) {
    return 0
  }

  if (remainingMatchCount > TERMINAL_CARD_SEARCH_LIMIT) {
    return canCompleteFullSlotsAfterSelection(pendingMatches, selectedIndexes, matchCount) ? 0 : null
  }

  const selectedIndexSet = new Set(selectedIndexes)
  const selectedMatches = selectedIndexes.map((index) => pendingMatches[index])
  const remainingMatches = pendingMatches.filter((_, index) => !selectedIndexSet.has(index))
  const nextLastCardSlots = new Map(lastCardSlots)

  for (const match of selectedMatches) {
    nextLastCardSlots.set(match.cardKey, slotNumber)
  }

  return findBestTerminalCardScore(
    remainingMatches,
    nextLastCardSlots,
    slotNumber + 1,
    matchCount,
    forbidImmediateCardRematches,
    new Map(),
  )
}

const canPartitionIntoFullSlots = (matches: PendingMatch[], matchCount: number): boolean => {
  if (matches.length === 0) {
    return true
  }

  if (matches.length % matchCount !== 0) {
    return false
  }

  const firstMatch = matches[0]

  if (firstMatch === undefined || matchCount === 1) {
    return true
  }

  if (matchCount === 2) {
    for (let secondIndex = 1; secondIndex < matches.length; secondIndex += 1) {
      if (hasTeamOverlap(firstMatch, matches[secondIndex])) {
        continue
      }

      const remainingMatches = matches.filter(
        (_, matchIndex) => matchIndex !== 0 && matchIndex !== secondIndex,
      )

      if (canPartitionIntoFullSlots(remainingMatches, matchCount)) {
        return true
      }
    }

    return false
  }

  for (let secondIndex = 1; secondIndex < matches.length - 1; secondIndex += 1) {
    const secondMatch = matches[secondIndex]

    if (hasTeamOverlap(firstMatch, secondMatch)) {
      continue
    }

    for (let thirdIndex = secondIndex + 1; thirdIndex < matches.length; thirdIndex += 1) {
      const thirdMatch = matches[thirdIndex]

      if (hasTeamOverlap(firstMatch, thirdMatch) || hasTeamOverlap(secondMatch, thirdMatch)) {
        continue
      }

      const remainingMatches = matches.filter(
        (_, matchIndex) =>
          matchIndex !== 0 && matchIndex !== secondIndex && matchIndex !== thirdIndex,
      )

      if (canPartitionIntoFullSlots(remainingMatches, matchCount)) {
        return true
      }
    }
  }

  return false
}

const canCompleteFullSlotsAfterSelection = (
  pendingMatches: PendingMatch[],
  selectedIndexes: number[],
  matchCount: number,
) => {
  const remainingMatchCount = pendingMatches.length - selectedIndexes.length

  if (remainingMatchCount === 0 || remainingMatchCount % matchCount !== 0) {
    return true
  }

  if (remainingMatchCount > COMPLETION_SEARCH_LIMIT) {
    return true
  }

  const selectedIndexSet = new Set(selectedIndexes)
  const remainingMatches = pendingMatches.filter((_, index) => !selectedIndexSet.has(index))

  return canPartitionIntoFullSlots(remainingMatches, matchCount)
}

const collectPlayingTeamIndexes = (matches: PendingMatch[]) => {
  const playingTeamIndexes = new Set<number>()

  for (const match of matches) {
    playingTeamIndexes.add(match.teamAIndex)
    playingTeamIndexes.add(match.teamBIndex)
  }

  return playingTeamIndexes
}

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
  let score = calculateSpread(nextRestCounts) * 900 + calculateSpread(nextPlayedCounts) * 130

  for (const [teamIndex, teamState] of teamStates.entries()) {
    const isPlaying = playingTeamIndexes.has(teamIndex)

    if (isPlaying) {
      if (teamState.currentRestStreak > 0) {
        score -= Math.min(teamState.currentRestStreak, 3) * 170
      }

      continue
    }

    const nextRestCount = teamState.restCount + 1
    const restDistanceFromAverage = nextRestCount - averageRestCount
    score += Math.max(0, restDistanceFromAverage) * 180
    score += nextRestCount * 18

    if (teamState.currentRestStreak > 0) {
      score += 12_000 + teamState.currentRestStreak * 4_000
    }

    if (teamState.currentPlayStreak >= 5) {
      score -= 72_000
    } else if (teamState.currentPlayStreak === 4) {
      score -= 54_000
    } else if (teamState.currentPlayStreak === 3) {
      score -= 36_000
    } else if (teamState.currentPlayStreak === 2) {
      score -= 1_200
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

    if (nextPlayStreak >= 6) {
      score += 190_000 + (nextPlayStreak - 6) * 48_000
    } else if (nextPlayStreak === 5) {
      score += 132_000
    } else if (nextPlayStreak === 4) {
      score += 80_000
    } else if (nextPlayStreak === 3) {
      score += 1_200
    } else if (nextPlayStreak === 2) {
      score += 50
    }
  }

  return score
}

const scoreCardIntervals = (
  selectedMatches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  preferWideSpacing = false,
) => scoreCardIntervalsForMatches(
  selectedMatches,
  lastCardSlots,
  slotNumber,
  preferWideSpacing,
)

const scoreSequence = (selectedMatches: PendingMatch[]) =>
  selectedMatches.reduce(
    (total, match) => total + match.sequence * 0.001 + match.repeatIndex * 0.01,
    0,
  )

const scoreCourtForTeam = (
  teamState: TeamScheduleState,
  court: ThreeCourtId,
  venueName: string,
) => {
  let score = 0

  if (teamState.lastCourt !== null && teamState.lastVenueName !== null) {
    const switchesCourt = teamState.lastCourt !== court
    const switchesVenue = teamState.lastVenueName !== venueName
    const restedBeforeSwitch = teamState.currentPlayStreak === 0
    const makesVenueRoundTrip =
      switchesVenue &&
      teamState.previousVenueName !== null &&
      teamState.previousVenueName === venueName

    if (switchesVenue) {
      score += restedBeforeSwitch ? 1_000 : 2_100 + teamState.currentPlayStreak * 600
    } else if (switchesCourt && teamState.currentPlayStreak > 0) {
      score += 180 + teamState.currentPlayStreak * 70
    } else if (switchesCourt) {
      score += 36
    } else if (teamState.currentPlayStreak > 0) {
      score -= 70 + Math.min(teamState.currentPlayStreak, 4) * 22
    } else {
      score -= 14
    }

    if (makesVenueRoundTrip) {
      score += restedBeforeSwitch ? 2_600 : 6_000
    }
  }

  const nextCourtCounts = THREE_COURTS.map((targetCourt) =>
    teamState.courtCounts[targetCourt] + (targetCourt === court ? 1 : 0),
  )
  score += calculateSpread(nextCourtCounts) * 3

  const nextVenueCountsByName = {
    ...teamState.venueCounts,
    [venueName]: (teamState.venueCounts[venueName] ?? 0) + 1,
  }
  score += calculateSpread(Object.values(nextVenueCountsByName)) * 2

  return score
}

const createCourtPlanOptions = (
  selectedIndexes: number[],
  availableCourts: readonly ThreeCourtId[] = THREE_COURTS,
): CourtPlan[][] => {
  if (selectedIndexes.length === 0) {
    return [[]]
  }

  const selectedIndex = selectedIndexes[0]

  if (selectedIndex === undefined) {
    return [[]]
  }

  return availableCourts.flatMap((court) =>
    createCourtPlanOptions(
      selectedIndexes.slice(1),
      availableCourts.filter((availableCourt) => availableCourt !== court),
    ).map((plans) => [
      {
        selectedIndex,
        court,
      },
      ...plans,
    ]),
  )
}

const scoreCourtPlans = (
  selectedIndexes: number[],
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  venueLookup: Map<ThreeCourtId, string>,
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
) => {
  const options = createCourtPlanOptions(selectedIndexes)
  let bestCourtPlans = options[0]
  let bestScore = Number.POSITIVE_INFINITY

  const shouldScoreCourtTurnover = new Set(venueLookup.values()).size === 1

  for (const option of options) {
    let optionScore = 0

    for (const courtPlan of option) {
      const match = pendingMatches[courtPlan.selectedIndex]
      const venueName = venueLookup.get(courtPlan.court) ?? DEFAULT_VENUE_NAME

      if (shouldScoreCourtTurnover) {
        optionScore += scoreCourtTurnover(
          previousCourtTeamIndexes.get(courtPlan.court),
          getCourtTeamIndexes(match),
        )
      }

      for (const teamIndex of getMatchTeamIndexes(match)) {
        optionScore += scoreCourtForTeam(teamStates[teamIndex], courtPlan.court, venueName)
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
  selectedIndexes: number[],
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  venueLookup: Map<ThreeCourtId, string>,
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
): SlotPlan => {
  const selectedMatches = selectedIndexes.map((selectedIndex) => pendingMatches[selectedIndex])
  const courtPlanResult = scoreCourtPlans(
    selectedIndexes,
    pendingMatches,
    teamStates,
    venueLookup,
    previousCourtTeamIndexes,
  )
  const score =
    scoreRestPlan(selectedMatches, teamStates) +
    scorePlayStreaks(selectedMatches, teamStates) +
    scoreCardIntervals(
      selectedMatches,
      lastCardSlots,
      slotNumber,
      new Set(venueLookup.values()).size === 1,
    ) +
    courtPlanResult.score +
    scoreSequence(selectedMatches)

  return {
    selectedIndexes,
    courtPlans: courtPlanResult.courtPlans,
    score,
  }
}

const evaluateCombination = (
  indexes: number[],
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  venueLookup: Map<ThreeCourtId, string>,
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
  forbidImmediateCardRematches: boolean,
  requiredFullMatchCount: number | null,
) => {
  const matches = indexes.map((index) => pendingMatches[index])

  if (hasAnyTeamOverlap(matches)) {
    return null
  }

  if (
    forbidImmediateCardRematches &&
    hasImmediateCardRematch(matches, lastCardSlots, slotNumber)
  ) {
    return null
  }

  const terminalCardScore = requiredFullMatchCount === null
    ? 0
    : scoreTerminalCardCompletionAfterSelection(
      pendingMatches,
      indexes,
      lastCardSlots,
      slotNumber,
      requiredFullMatchCount,
      forbidImmediateCardRematches,
    )

  if (terminalCardScore === null) {
    return null
  }

  const slotPlan = scoreSlotPlan(
    indexes,
    pendingMatches,
    teamStates,
    lastCardSlots,
    slotNumber,
    venueLookup,
    previousCourtTeamIndexes,
  )

  return {
    ...slotPlan,
    score: slotPlan.score + terminalCardScore * TERMINAL_CARD_SCORE_WEIGHT,
  }
}

const findBestPlanForMatchCount = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  venueLookup: Map<ThreeCourtId, string>,
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
  forbidImmediateCardRematches: boolean,
  matchCount: number,
  windowSize: number,
  requiredFullMatchCount: number | null,
) => {
  let bestPlan: SlotPlan | null = null

  if (matchCount === 1) {
    for (let firstIndex = 0; firstIndex < windowSize; firstIndex += 1) {
      const plan = evaluateCombination(
        [firstIndex],
        pendingMatches,
        teamStates,
        lastCardSlots,
        slotNumber,
        venueLookup,
        previousCourtTeamIndexes,
        forbidImmediateCardRematches,
        requiredFullMatchCount,
      )

      if (plan !== null && (bestPlan === null || plan.score < bestPlan.score)) {
        bestPlan = plan
      }
    }

    return bestPlan
  }

  if (matchCount === 2) {
    for (let firstIndex = 0; firstIndex < windowSize - 1; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < windowSize; secondIndex += 1) {
        const plan = evaluateCombination(
          [firstIndex, secondIndex],
          pendingMatches,
          teamStates,
          lastCardSlots,
          slotNumber,
          venueLookup,
          previousCourtTeamIndexes,
          forbidImmediateCardRematches,
          requiredFullMatchCount,
        )

        if (plan !== null && (bestPlan === null || plan.score < bestPlan.score)) {
          bestPlan = plan
        }
      }
    }

    return bestPlan
  }

  for (let firstIndex = 0; firstIndex < windowSize - 2; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < windowSize - 1; secondIndex += 1) {
      if (hasTeamOverlap(pendingMatches[firstIndex], pendingMatches[secondIndex])) {
        continue
      }

      for (let thirdIndex = secondIndex + 1; thirdIndex < windowSize; thirdIndex += 1) {
        const plan = evaluateCombination(
          [firstIndex, secondIndex, thirdIndex],
          pendingMatches,
          teamStates,
          lastCardSlots,
          slotNumber,
          venueLookup,
          previousCourtTeamIndexes,
          forbidImmediateCardRematches,
          requiredFullMatchCount,
        )

        if (plan !== null && (bestPlan === null || plan.score < bestPlan.score)) {
          bestPlan = plan
        }
      }
    }
  }

  return bestPlan
}

const chooseMatchesForSlot = (
  pendingMatches: PendingMatch[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  venueLookup: Map<ThreeCourtId, string>,
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
) => {
  const targetMatchCount = Math.min(
    THREE_COURTS.length,
    Math.floor(teamStates.length / 2),
    pendingMatches.length,
  )

  for (let matchCount = targetMatchCount; matchCount >= 1; matchCount -= 1) {
    for (const forbidImmediateCardRematches of [true, false]) {
      const candidateWindowSize = Math.min(CANDIDATE_WINDOW_SIZE, pendingMatches.length)
      const candidatePlan = findBestPlanForMatchCount(
        pendingMatches,
        teamStates,
        lastCardSlots,
        slotNumber,
        venueLookup,
        previousCourtTeamIndexes,
        forbidImmediateCardRematches,
        matchCount,
        candidateWindowSize,
        matchCount === targetMatchCount ? targetMatchCount : null,
      )

      if (candidatePlan !== null) {
        return candidatePlan
      }

      const fallbackWindowSize = Math.min(FALLBACK_WINDOW_SIZE, pendingMatches.length)
      const fallbackPlan = findBestPlanForMatchCount(
        pendingMatches,
        teamStates,
        lastCardSlots,
        slotNumber,
        venueLookup,
        previousCourtTeamIndexes,
        forbidImmediateCardRematches,
        matchCount,
        fallbackWindowSize,
        matchCount === targetMatchCount ? targetMatchCount : null,
      )

      if (fallbackPlan !== null) {
        return fallbackPlan
      }
    }
  }

  throw new Error('組み合わせを作成できませんでした。')
}

const toScheduleMatch = (match: PendingMatch, teams: Team[]): ScheduleMatch => ({
  id: match.id,
  teamA: teams[match.teamAIndex],
  teamB: teams[match.teamBIndex],
  cardKey: match.cardKey,
})

const createEmptyAssignment = (court: ThreeCourtId): CourtAssignment => ({
  court,
  match: null,
})

const createInitialPreviousCourtTeamIndexes = () =>
  new Map<ThreeCourtId, CourtTeamIndexes | null>(
    THREE_COURTS.map((court) => [court, null]),
  )

const updatePreviousCourtTeamIndexes = (
  previousCourtTeamIndexes: Map<ThreeCourtId, CourtTeamIndexes | null>,
  pendingMatches: PendingMatch[],
  courtPlans: CourtPlan[],
) => {
  THREE_COURTS.forEach((court) => previousCourtTeamIndexes.set(court, null))

  courtPlans.forEach((courtPlan) => {
    previousCourtTeamIndexes.set(
      courtPlan.court,
      getCourtTeamIndexes(pendingMatches[courtPlan.selectedIndex]),
    )
  })
}

const buildCourtAssignments = (
  pendingMatches: PendingMatch[],
  courtPlans: CourtPlan[],
  teams: Team[],
): CourtAssignment[] =>
  THREE_COURTS.map((court) => {
    const courtPlan = courtPlans.find((plan) => plan.court === court)

    if (courtPlan === undefined) {
      return createEmptyAssignment(court)
    }

    return {
      court,
      match: toScheduleMatch(pendingMatches[courtPlan.selectedIndex], teams),
    }
  })


const createAlwaysActiveMatchSlots = (
  teamCount: number,
  roundCount: number,
): PendingMatch[][] => {
  const roundRobinRounds = createRoundRobinRounds(teamCount)
  const slots: PendingMatch[][] = []
  let sequence = 0

  for (let repeatIndex = 0; repeatIndex < roundCount; repeatIndex += 1) {
    roundRobinRounds.forEach((roundPairs, roundIndex) => {
      const slotMatches = roundPairs.map(([teamAIndex, teamBIndex], pairIndex) => {
        const matchSequence = sequence
        sequence += 1

        return {
          id:
            'match-' +
            String(repeatIndex + 1) +
            '-' +
            String(roundIndex + 1) +
            '-' +
            String(pairIndex + 1),
          teamAIndex,
          teamBIndex,
          cardKey: createCardKey(teamAIndex, teamBIndex),
          repeatIndex,
          sequence: matchSequence,
        }
      })

      slots.push(slotMatches)
    })
  }

  return slots
}

const getCourtCode = (court: ThreeCourtId) => THREE_COURTS.indexOf(court) + 1

const createVenueCodeLookup = (venueLookup: Map<ThreeCourtId, string>) => {
  const codeByVenueName = new Map<string, number>()
  const codeByCourt = new Map<ThreeCourtId, number>()

  THREE_COURTS.forEach((court) => {
    const venueName = venueLookup.get(court) ?? DEFAULT_VENUE_NAME
    let venueCode = codeByVenueName.get(venueName)

    if (venueCode === undefined) {
      venueCode = codeByVenueName.size + 1
      codeByVenueName.set(venueName, venueCode)
    }

    codeByCourt.set(court, venueCode)
  })

  return codeByCourt
}

const sumValues = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0)

const maxValue = (values: readonly number[]) => Math.max(...values)

const getVenueUseSpread = (state: AlwaysActiveCourtState) => {
  const venueCount = state.teamVenueUseCounts[0]?.length ?? 0
  let spread = 0

  for (let venueIndex = 0; venueIndex < venueCount; venueIndex += 1) {
    spread += calculateSpread(
      state.teamVenueUseCounts.map((venueCounts) => venueCounts[venueIndex] ?? 0),
    )
  }

  return spread
}

const getAlwaysActiveStateSortValues = (state: AlwaysActiveCourtState) => [
  sumValues(state.teamVenueRoundTrips),
  maxValue(state.teamVenueRoundTrips),
  maxValue(state.teamVenueMoves),
  getVenueUseSpread(state),
  sumValues(state.teamVenueMoves),
  calculateSpread(state.teamVenueMoves),
  state.sameCourtCardRepeatCount,
  state.twoTeamChangeCount,
  -state.oneTeamChangeCount,
  maxValue(state.teamCourtMoves),
  sumValues(state.teamCourtMoves),
  calculateSpread(state.teamCourtMoves),
  state.orderScore,
]

const compareAlwaysActiveCourtStates = (
  first: AlwaysActiveCourtState,
  second: AlwaysActiveCourtState,
) => {
  const firstValues = getAlwaysActiveStateSortValues(first)
  const secondValues = getAlwaysActiveStateSortValues(second)

  for (let index = 0; index < firstValues.length; index += 1) {
    const difference = firstValues[index] - secondValues[index]

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

const createAlwaysActiveStateKey = (state: AlwaysActiveCourtState) =>
  [
    state.lastCourts.join(','),
    state.lastVenues.join(','),
    state.previousVenues.join(','),
    state.lastCourtTeamIndexes
      .map((teamIndexes) => teamIndexes?.join('-') ?? 'empty')
      .join(','),
  ].join('|')

const scoreAlwaysActiveCourtPlanOrder = (courtPlans: readonly CourtPlan[]) =>
  courtPlans.reduce(
    (score, courtPlan, index) =>
      score + getCourtCode(courtPlan.court) * (courtPlan.selectedIndex + 1) * (index + 1) * 0.001,
    0,
  )

const limitAlwaysActiveCourtStates = (
  states: Map<string, AlwaysActiveCourtState>,
) => {
  if (states.size <= ALWAYS_ACTIVE_COURT_STATE_LIMIT) {
    return states
  }

  return new Map(
    [...states.values()]
      .sort(compareAlwaysActiveCourtStates)
      .slice(0, ALWAYS_ACTIVE_COURT_STATE_LIMIT)
      .map((state) => [createAlwaysActiveStateKey(state), state]),
  )
}

const createAlwaysActiveCourtPlanSlots = (
  matchSlots: PendingMatch[][],
  teamCount: number,
  venueLookup: Map<ThreeCourtId, string>,
) => {
  const initialCourts = Array.from({ length: teamCount }, () => 0)
  const initialVenues = Array.from({ length: teamCount }, () => 0)
  const venueCodeLookup = createVenueCodeLookup(venueLookup)
  const venueCount = Math.max(...venueCodeLookup.values())
  let states = new Map<string, AlwaysActiveCourtState>()

  const initialState: AlwaysActiveCourtState = {
    lastCourts: initialCourts,
    lastVenues: initialVenues,
    previousVenues: initialVenues,
    teamCourtMoves: Array.from({ length: teamCount }, () => 0),
    teamVenueMoves: Array.from({ length: teamCount }, () => 0),
    teamVenueRoundTrips: Array.from({ length: teamCount }, () => 0),
    teamVenueUseCounts: Array.from({ length: teamCount }, () =>
      Array.from({ length: venueCount }, () => 0),
    ),
    lastCourtTeamIndexes: THREE_COURTS.map(() => null),
    oneTeamChangeCount: 0,
    twoTeamChangeCount: 0,
    sameCourtCardRepeatCount: 0,
    orderScore: 0,
    courtPlanSlots: [],
  }

  states.set(createAlwaysActiveStateKey(initialState), initialState)

  for (const selectedMatches of matchSlots) {
    const nextStates = new Map<string, AlwaysActiveCourtState>()
    const courtPlanOptions = createCourtPlanOptions(
      selectedMatches.map((_, matchIndex) => matchIndex),
    )

    for (const state of states.values()) {
      for (const courtPlans of courtPlanOptions) {
        const nextLastCourts = [...state.lastCourts]
        const nextLastVenues = [...state.lastVenues]
        const nextPreviousVenues = [...state.previousVenues]
        const nextLastCourtTeamIndexes: Array<CourtTeamIndexes | null> = THREE_COURTS.map(() => null)
        const nextTeamCourtMoves = [...state.teamCourtMoves]
        const nextTeamVenueMoves = [...state.teamVenueMoves]
        const nextTeamVenueRoundTrips = [...state.teamVenueRoundTrips]
        const nextTeamVenueUseCounts = state.teamVenueUseCounts.map((venueCounts) => [
          ...venueCounts,
        ])
        let oneTeamChangeCount = state.oneTeamChangeCount
        let twoTeamChangeCount = state.twoTeamChangeCount
        let sameCourtCardRepeatCount = state.sameCourtCardRepeatCount

        for (const courtPlan of courtPlans) {
          const match = selectedMatches[courtPlan.selectedIndex]
          const courtCode = getCourtCode(courtPlan.court)
          const courtIndex = courtCode - 1
          const venueCode = venueCodeLookup.get(courtPlan.court) ?? 1
          const courtTeamIndexes = getCourtTeamIndexes(match)
          const previousCourtTeamIndexes = state.lastCourtTeamIndexes[courtIndex]

          if (previousCourtTeamIndexes !== null) {
            const sharedTeamCount = countSharedCourtTeams(
              previousCourtTeamIndexes,
              courtTeamIndexes,
            )

            if (sharedTeamCount === 2) {
              sameCourtCardRepeatCount += 1
            } else if (sharedTeamCount === 1) {
              oneTeamChangeCount += 1
            } else {
              twoTeamChangeCount += 1
            }
          }

          nextLastCourtTeamIndexes[courtIndex] = courtTeamIndexes

          for (const teamIndex of getMatchTeamIndexes(match)) {
            const lastCourt = nextLastCourts[teamIndex]
            const lastVenue = nextLastVenues[teamIndex]
            const previousVenue = nextPreviousVenues[teamIndex]

            if (lastCourt !== 0 && lastCourt !== courtCode) {
              nextTeamCourtMoves[teamIndex] += 1
            }

            if (lastVenue !== 0 && lastVenue !== venueCode) {
              nextTeamVenueMoves[teamIndex] += 1

              if (previousVenue === venueCode) {
                nextTeamVenueRoundTrips[teamIndex] += 1
              }
            }

            nextTeamVenueUseCounts[teamIndex][venueCode - 1] += 1
            nextPreviousVenues[teamIndex] = lastVenue
            nextLastCourts[teamIndex] = courtCode
            nextLastVenues[teamIndex] = venueCode
          }
        }

        const nextState: AlwaysActiveCourtState = {
          lastCourts: nextLastCourts,
          lastVenues: nextLastVenues,
          previousVenues: nextPreviousVenues,
          teamCourtMoves: nextTeamCourtMoves,
          teamVenueMoves: nextTeamVenueMoves,
          teamVenueRoundTrips: nextTeamVenueRoundTrips,
          teamVenueUseCounts: nextTeamVenueUseCounts,
          lastCourtTeamIndexes: nextLastCourtTeamIndexes,
          oneTeamChangeCount,
          twoTeamChangeCount,
          sameCourtCardRepeatCount,
          orderScore: state.orderScore + scoreAlwaysActiveCourtPlanOrder(courtPlans),
          courtPlanSlots: [...state.courtPlanSlots, courtPlans],
        }
        const stateKey = createAlwaysActiveStateKey(nextState)
        const currentState = nextStates.get(stateKey)

        if (
          currentState === undefined ||
          compareAlwaysActiveCourtStates(nextState, currentState) < 0
        ) {
          nextStates.set(stateKey, nextState)
        }
      }
    }

    states = limitAlwaysActiveCourtStates(nextStates)
  }

  const [bestState] = [...states.values()].sort(compareAlwaysActiveCourtStates)

  return bestState?.courtPlanSlots ?? []
}

const buildAlwaysActiveCourtAssignments = (
  selectedMatches: PendingMatch[],
  courtPlans: CourtPlan[],
  teams: Team[],
): CourtAssignment[] =>
  THREE_COURTS.map((court) => {
    const courtPlan = courtPlans.find((plan) => plan.court === court)

    if (courtPlan === undefined) {
      return createEmptyAssignment(court)
    }

    return {
      court,
      match: toScheduleMatch(selectedMatches[courtPlan.selectedIndex], teams),
    }
  })

const createAlwaysActiveScheduleSlots = (
  teams: Team[],
  roundCount: number,
  venueLookup: Map<ThreeCourtId, string>,
): ScheduleSlot[] => {
  const matchSlots = createAlwaysActiveMatchSlots(teams.length, roundCount)
  const courtPlanSlots = createAlwaysActiveCourtPlanSlots(matchSlots, teams.length, venueLookup)

  return matchSlots.map((selectedMatches, slotIndex) => ({
    slotNumber: slotIndex + 1,
    courts: buildAlwaysActiveCourtAssignments(selectedMatches, courtPlanSlots[slotIndex], teams),
    restingTeams: [],
  }))
}

const updateScheduleState = (
  pendingMatches: PendingMatch[],
  courtPlans: CourtPlan[],
  teamStates: TeamScheduleState[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
  venueLookup: Map<ThreeCourtId, string>,
) => {
  const courtByTeamIndex = new Map<number, ThreeCourtId>()
  const selectedMatches = courtPlans.map((courtPlan) => pendingMatches[courtPlan.selectedIndex])

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

    const venueName = venueLookup.get(court) ?? DEFAULT_VENUE_NAME

    teamState.played += 1
    teamState.currentPlayStreak += 1
    teamState.currentRestStreak = 0
    teamState.previousVenueName = teamState.lastVenueName
    teamState.lastCourt = court
    teamState.lastVenueName = venueName
    teamState.courtCounts[court] += 1
    teamState.venueCounts[venueName] = (teamState.venueCounts[venueName] ?? 0) + 1
  }

  for (const match of selectedMatches) {
    lastCardSlots.set(match.cardKey, slotNumber)
  }
}

const removeSelectedMatches = (
  pendingMatches: PendingMatch[],
  selectedIndexes: number[],
) => {
  const descendingIndexes = [...selectedIndexes].sort((first, second) => second - first)
  const selectedMatches = selectedIndexes.map((selectedIndex) => pendingMatches[selectedIndex])

  for (const selectedIndex of descendingIndexes) {
    pendingMatches.splice(selectedIndex, 1)
  }

  return selectedMatches
}

type ScheduleQuality = {
  score: number
  invalidSlotCount: number
  sameCourtCardConsecutiveCount: number
  oneTeamChangeCount: number
  twoTeamChangeCount: number
  sameCardConsecutiveCount: number
  repeatsWithin2Slots: number
  minRepeatGap: number | null
  maxPlayStreak: number
  maxRestStreak: number
  restSpread: number
  playSpread: number
  totalCourtMoves: number
  totalVenueMoves: number
  totalVenueRoundTrips: number
}

const rebuildRestingTeams = (slot: ScheduleSlot, teams: Team[]) => {
  const playingTeamIds = new Set<string>()

  for (const assignment of slot.courts) {
    if (assignment.match === null) {
      continue
    }

    playingTeamIds.add(assignment.match.teamA.id)
    playingTeamIds.add(assignment.match.teamB.id)
  }

  return teams.filter((team) => !playingTeamIds.has(team.id))
}

const cloneScheduleSlots = (slots: ScheduleSlot[]): ScheduleSlot[] =>
  slots.map((slot) => ({
    ...slot,
    courts: slot.courts.map((assignment) => ({ ...assignment })),
    restingTeams: [...slot.restingTeams],
  }))

const hasSlotTeamDuplication = (slot: ScheduleSlot) => {
  const playingTeamIds = new Set<string>()

  for (const assignment of slot.courts) {
    if (assignment.match === null) {
      continue
    }

    for (const team of [assignment.match.teamA, assignment.match.teamB]) {
      if (playingTeamIds.has(team.id)) {
        return true
      }

      playingTeamIds.add(team.id)
    }
  }

  return false
}

const calculateScheduleQuality = (
  slots: ScheduleSlot[],
  teams: Team[],
  venueLookup: Map<ThreeCourtId, string>,
): ScheduleQuality => {
  const teamStats = new Map(
    teams.map((team) => [
      team.id,
      {
        playCount: 0,
        restCount: 0,
        currentPlayStreak: 0,
        currentRestStreak: 0,
        maxPlayStreak: 0,
        maxRestStreak: 0,
        courtMoves: 0,
        venueMoves: 0,
        venueRoundTrips: 0,
        lastCourt: null as ThreeCourtId | null,
        lastVenueName: null as string | null,
        venueHistory: [] as string[],
      },
    ]),
  )
  const lastCardSlots = new Map<string, number>()
  let invalidSlotCount = 0
  let sameCourtCardConsecutiveCount = 0
  let oneTeamChangeCount = 0
  let twoTeamChangeCount = 0
  let sameCardConsecutiveCount = 0
  let repeatsWithin2Slots = 0
  let minRepeatGap: number | null = null
  const lastCourtTeamIds = new Map<string, string[]>()
  const lastCourtCardKeys = new Map<string, string>()

  for (const slot of slots) {
    if (hasSlotTeamDuplication(slot)) {
      invalidSlotCount += 1
    }

    const courtByTeamId = new Map<string, ThreeCourtId>()
    const venueByTeamId = new Map<string, string>()

    for (const assignment of slot.courts) {
      if (assignment.match === null) {
        continue
      }

      const previousCourtTeamIds = lastCourtTeamIds.get(assignment.court)
      const nextCourtTeamIds = [assignment.match.teamA.id, assignment.match.teamB.id]

      if (previousCourtTeamIds !== undefined) {
        const sharedTeamCount = nextCourtTeamIds.filter((teamId) =>
          previousCourtTeamIds.includes(teamId),
        ).length
        const repeatsSameCourtCard =
          lastCourtCardKeys.get(assignment.court) === assignment.match.cardKey

        if (repeatsSameCourtCard || sharedTeamCount === 2) {
          sameCourtCardConsecutiveCount += 1
        } else if (sharedTeamCount === 1) {
          oneTeamChangeCount += 1
        } else {
          twoTeamChangeCount += 1
        }
      }

      lastCourtTeamIds.set(assignment.court, nextCourtTeamIds)
      lastCourtCardKeys.set(assignment.court, assignment.match.cardKey)

      const lastCardSlot = lastCardSlots.get(assignment.match.cardKey)
      if (lastCardSlot !== undefined) {
        const gap = slot.slotNumber - lastCardSlot
        minRepeatGap = minRepeatGap === null ? gap : Math.min(minRepeatGap, gap)

        if (gap === 1) {
          sameCardConsecutiveCount += 1
        }

        if (gap <= 2) {
          repeatsWithin2Slots += 1
        }
      }
      lastCardSlots.set(assignment.match.cardKey, slot.slotNumber)

      const venueName = venueLookup.get(assignment.court as ThreeCourtId) ?? DEFAULT_VENUE_NAME
      courtByTeamId.set(assignment.match.teamA.id, assignment.court as ThreeCourtId)
      courtByTeamId.set(assignment.match.teamB.id, assignment.court as ThreeCourtId)
      venueByTeamId.set(assignment.match.teamA.id, venueName)
      venueByTeamId.set(assignment.match.teamB.id, venueName)
    }

    for (const team of teams) {
      const teamStat = teamStats.get(team.id)
      if (teamStat === undefined) {
        continue
      }

      const court = courtByTeamId.get(team.id)
      const venueName = venueByTeamId.get(team.id)

      if (court === undefined || venueName === undefined) {
        teamStat.restCount += 1
        teamStat.currentRestStreak += 1
        teamStat.currentPlayStreak = 0
        teamStat.maxRestStreak = Math.max(teamStat.maxRestStreak, teamStat.currentRestStreak)
        continue
      }

      teamStat.playCount += 1
      teamStat.currentPlayStreak += 1
      teamStat.currentRestStreak = 0
      teamStat.maxPlayStreak = Math.max(teamStat.maxPlayStreak, teamStat.currentPlayStreak)

      if (teamStat.lastCourt !== null && teamStat.lastCourt !== court) {
        teamStat.courtMoves += 1
      }

      if (teamStat.lastVenueName !== null && teamStat.lastVenueName !== venueName) {
        teamStat.venueMoves += 1
      }

      teamStat.venueHistory.push(venueName)
      if (teamStat.venueHistory.length >= 3) {
        const lastIndex = teamStat.venueHistory.length - 1
        const currentVenue = teamStat.venueHistory[lastIndex]
        const previousVenue = teamStat.venueHistory[lastIndex - 1]
        const beforePreviousVenue = teamStat.venueHistory[lastIndex - 2]

        if (currentVenue === beforePreviousVenue && currentVenue !== previousVenue) {
          teamStat.venueRoundTrips += 1
        }
      }

      teamStat.lastCourt = court
      teamStat.lastVenueName = venueName
    }
  }

  const stats = Array.from(teamStats.values())
  const playCounts = stats.map((stat) => stat.playCount)
  const restCounts = stats.map((stat) => stat.restCount)
  const maxPlayStreak = Math.max(...stats.map((stat) => stat.maxPlayStreak))
  const maxRestStreak = Math.max(...stats.map((stat) => stat.maxRestStreak))
  const restSpread = calculateSpread(restCounts)
  const playSpread = calculateSpread(playCounts)
  const totalCourtMoves = stats.reduce((total, stat) => total + stat.courtMoves, 0)
  const totalVenueMoves = stats.reduce((total, stat) => total + stat.venueMoves, 0)
  const totalVenueRoundTrips = stats.reduce((total, stat) => total + stat.venueRoundTrips, 0)
  const score =
    invalidSlotCount * 1_000_000_000 +
    Math.max(0, maxPlayStreak - 3) * 600_000 +
    Math.max(0, maxRestStreak - 1) * 500_000 +
    restSpread * 180_000 +
    playSpread * 120_000 +
    sameCardConsecutiveCount * 2_000_000 +
    repeatsWithin2Slots * 180_000 +
    totalVenueRoundTrips * 220_000 +
    totalVenueMoves * 520 +
    sameCourtCardConsecutiveCount * 320_000 +
    twoTeamChangeCount * 520 -
    oneTeamChangeCount * 140 +
    totalCourtMoves * 70

  return {
    score,
    invalidSlotCount,
    sameCourtCardConsecutiveCount,
    oneTeamChangeCount,
    twoTeamChangeCount,
    sameCardConsecutiveCount,
    repeatsWithin2Slots,
    minRepeatGap,
    maxPlayStreak,
    maxRestStreak,
    restSpread,
    playSpread,
    totalCourtMoves,
    totalVenueMoves,
    totalVenueRoundTrips,
  }
}

const keepsCriticalQuality = (candidate: ScheduleQuality, baseline: ScheduleQuality) =>
  candidate.invalidSlotCount === 0 &&
  candidate.maxPlayStreak <= baseline.maxPlayStreak &&
  candidate.maxRestStreak <= baseline.maxRestStreak &&
  candidate.restSpread <= baseline.restSpread &&
  candidate.playSpread <= baseline.playSpread &&
  candidate.sameCardConsecutiveCount <= baseline.sameCardConsecutiveCount &&
  candidate.sameCourtCardConsecutiveCount <= baseline.sameCourtCardConsecutiveCount &&
  candidate.repeatsWithin2Slots <= baseline.repeatsWithin2Slots &&
  candidate.totalVenueRoundTrips <= baseline.totalVenueRoundTrips

type RestLockedCourtPlan = {
  court: ThreeCourtId
  teamIndexes: CourtTeamIndexes
  cardKey: string
}

type RestLockedRescheduleState = {
  remainingCardCounts: number[]
  lastCardSlots: number[]
  lastCourts: number[]
  lastVenues: number[]
  previousVenues: number[]
  teamCourtMoves: number[]
  teamVenueMoves: number[]
  teamVenueRoundTrips: number[]
  lastCourtTeamIndexes: Array<CourtTeamIndexes | null>
  repeatsWithin2Slots: number
  minRepeatGap: number
  oneTeamChangeCount: number
  twoTeamChangeCount: number
  sameCourtCardRepeatCount: number
  orderScore: number
  courtPlanSlots: RestLockedCourtPlan[][]
}

const createTeamPairIndexes = (teamCount: number): CourtTeamIndexes[] => {
  const pairIndexes: CourtTeamIndexes[] = []

  for (let firstIndex = 0; firstIndex < teamCount - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < teamCount; secondIndex += 1) {
      pairIndexes.push([firstIndex, secondIndex])
    }
  }

  return pairIndexes
}

const createActiveTeamIndexesBySlot = (slots: ScheduleSlot[], teams: Team[]) => {
  const teamIndexById = new Map(teams.map((team, teamIndex) => [team.id, teamIndex]))

  return slots.map((slot) => {
    const restingTeamIndexes = new Set(
      slot.restingTeams
        .map((team) => teamIndexById.get(team.id))
        .filter((teamIndex): teamIndex is number => teamIndex !== undefined),
    )

    return teams
      .map((_, teamIndex) => teamIndex)
      .filter((teamIndex) => !restingTeamIndexes.has(teamIndex))
  })
}

const createPerfectMatchings = (activeTeamIndexes: number[]): CourtTeamIndexes[][] => {
  if (activeTeamIndexes.length === 0) {
    return [[]]
  }

  const firstTeamIndex = activeTeamIndexes[0]
  if (firstTeamIndex === undefined) {
    return [[]]
  }

  return activeTeamIndexes.slice(1).flatMap((secondTeamIndex) => {
    const remainingTeamIndexes = activeTeamIndexes.filter(
      (teamIndex) => teamIndex !== firstTeamIndex && teamIndex !== secondTeamIndex,
    )

    return createPerfectMatchings(remainingTeamIndexes).map((matchings) => [
      [firstTeamIndex, secondTeamIndex] as const,
      ...matchings,
    ])
  })
}

const createRestLockedCourtPlanOptions = (
  teamPairs: CourtTeamIndexes[],
  availableCourts: readonly ThreeCourtId[] = THREE_COURTS,
): RestLockedCourtPlan[][] => {
  if (teamPairs.length === 0) {
    return [[]]
  }

  const teamPair = teamPairs[0]
  if (teamPair === undefined) {
    return [[]]
  }

  return availableCourts.flatMap((court) =>
    createRestLockedCourtPlanOptions(
      teamPairs.slice(1),
      availableCourts.filter((availableCourt) => availableCourt !== court),
    ).map((courtPlans) => [
      {
        court,
        teamIndexes: teamPair,
        cardKey: createCardKey(teamPair[0], teamPair[1]),
      },
      ...courtPlans,
    ]),
  )
}

const createRestLockedSlotOptions = (activeTeamIndexesBySlot: number[][]) =>
  activeTeamIndexesBySlot.map((activeTeamIndexes) =>
    createPerfectMatchings(activeTeamIndexes).flatMap((teamPairs) =>
      createRestLockedCourtPlanOptions(teamPairs),
    ),
  )

const createFutureCardAvailabilityCounts = (
  activeTeamIndexesBySlot: number[][],
  teamPairs: CourtTeamIndexes[],
) => {
  const futureCounts = Array.from(
    { length: activeTeamIndexesBySlot.length + 1 },
    () => Array.from({ length: teamPairs.length }, () => 0),
  )

  for (let slotIndex = activeTeamIndexesBySlot.length - 1; slotIndex >= 0; slotIndex -= 1) {
    futureCounts[slotIndex] = [...futureCounts[slotIndex + 1]]
    const activeTeamIndexes = new Set(activeTeamIndexesBySlot[slotIndex])

    teamPairs.forEach(([teamAIndex, teamBIndex], cardIndex) => {
      if (activeTeamIndexes.has(teamAIndex) && activeTeamIndexes.has(teamBIndex)) {
        futureCounts[slotIndex][cardIndex] += 1
      }
    })
  }

  return futureCounts
}

const canPlaceRemainingCards = (
  remainingCardCounts: number[],
  futureCardAvailabilityCounts: number[][],
  nextSlotIndex: number,
) =>
  remainingCardCounts.every(
    (remainingCount, cardIndex) =>
      remainingCount >= 0 && remainingCount <= futureCardAvailabilityCounts[nextSlotIndex][cardIndex],
  )

const getRestLockedStateSortValues = (state: RestLockedRescheduleState) => [
  sumValues(state.teamVenueRoundTrips),
  maxValue(state.teamVenueRoundTrips),
  state.sameCourtCardRepeatCount,
  state.repeatsWithin2Slots,
  state.minRepeatGap === Number.POSITIVE_INFINITY ? -99 : -state.minRepeatGap,
  maxValue(state.teamVenueMoves),
  sumValues(state.teamVenueMoves),
  calculateSpread(state.teamVenueMoves),
  state.twoTeamChangeCount,
  -state.oneTeamChangeCount,
  maxValue(state.teamCourtMoves),
  sumValues(state.teamCourtMoves),
  calculateSpread(state.teamCourtMoves),
  state.orderScore,
]

const compareRestLockedStates = (
  first: RestLockedRescheduleState,
  second: RestLockedRescheduleState,
) => {
  const firstValues = getRestLockedStateSortValues(first)
  const secondValues = getRestLockedStateSortValues(second)

  for (let index = 0; index < firstValues.length; index += 1) {
    const difference = firstValues[index] - secondValues[index]

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

const createRestLockedMemoKey = (slotIndex: number, state: RestLockedRescheduleState) =>
  [
    slotIndex,
    state.remainingCardCounts.join(','),
    state.lastCardSlots.join(','),
    state.lastVenues.join(','),
    state.previousVenues.join(','),
    state.lastCourtTeamIndexes
      .map((teamIndexes) => teamIndexes?.join('-') ?? 'empty')
      .join(','),
  ].join('|')

const createNextRestLockedState = (
  state: RestLockedRescheduleState,
  courtPlans: RestLockedCourtPlan[],
  slotIndex: number,
  cardIndexByKey: Map<string, number>,
  futureCardAvailabilityCounts: number[][],
  venueCodeLookup: Map<ThreeCourtId, number>,
  forbidVenueRoundTrips: boolean,
) => {
  const slotNumber = slotIndex + 1
  const nextRemainingCardCounts = [...state.remainingCardCounts]
  const nextLastCardSlots = [...state.lastCardSlots]
  const nextLastCourts = [...state.lastCourts]
  const nextLastVenues = [...state.lastVenues]
  const nextPreviousVenues = [...state.previousVenues]
  const nextTeamCourtMoves = [...state.teamCourtMoves]
  const nextTeamVenueMoves = [...state.teamVenueMoves]
  const nextTeamVenueRoundTrips = [...state.teamVenueRoundTrips]
  const nextLastCourtTeamIndexes: Array<CourtTeamIndexes | null> = THREE_COURTS.map(() => null)
  let repeatsWithin2Slots = state.repeatsWithin2Slots
  let minRepeatGap = state.minRepeatGap
  let oneTeamChangeCount = state.oneTeamChangeCount
  let twoTeamChangeCount = state.twoTeamChangeCount
  let sameCourtCardRepeatCount = state.sameCourtCardRepeatCount
  let orderScore = state.orderScore

  for (const [planIndex, courtPlan] of courtPlans.entries()) {
    const cardIndex = cardIndexByKey.get(courtPlan.cardKey)

    if (cardIndex === undefined || nextRemainingCardCounts[cardIndex] <= 0) {
      return null
    }

    if (slotNumber > 1 && nextLastCardSlots[cardIndex] === slotNumber - 1) {
      return null
    }

    const lastCardSlot = nextLastCardSlots[cardIndex]
    if (lastCardSlot > 0) {
      const gap = slotNumber - lastCardSlot
      minRepeatGap = Math.min(minRepeatGap, gap)

      if (gap <= 2) {
        repeatsWithin2Slots += 1
      }
    }

    nextRemainingCardCounts[cardIndex] -= 1
    nextLastCardSlots[cardIndex] = slotNumber

    const courtCode = getCourtCode(courtPlan.court)
    const courtIndex = courtCode - 1
    const venueCode = venueCodeLookup.get(courtPlan.court) ?? 1
    const previousCourtTeamIndexes = state.lastCourtTeamIndexes[courtIndex]

    if (previousCourtTeamIndexes !== null) {
      const sharedTeamCount = countSharedCourtTeams(
        previousCourtTeamIndexes,
        courtPlan.teamIndexes,
      )

      if (sharedTeamCount === 2) {
        sameCourtCardRepeatCount += 1
      } else if (sharedTeamCount === 1) {
        oneTeamChangeCount += 1
      } else {
        twoTeamChangeCount += 1
      }
    }

    nextLastCourtTeamIndexes[courtIndex] = courtPlan.teamIndexes

    for (const teamIndex of courtPlan.teamIndexes) {
      const lastCourt = nextLastCourts[teamIndex]
      const lastVenue = nextLastVenues[teamIndex]
      const previousVenue = nextPreviousVenues[teamIndex]

      if (lastCourt !== 0 && lastCourt !== courtCode) {
        nextTeamCourtMoves[teamIndex] += 1
      }

      if (lastVenue !== 0 && lastVenue !== venueCode) {
        if (previousVenue === venueCode) {
          if (forbidVenueRoundTrips) {
            return null
          }

          nextTeamVenueRoundTrips[teamIndex] += 1
        }

        nextTeamVenueMoves[teamIndex] += 1
      }

      nextPreviousVenues[teamIndex] = lastVenue
      nextLastCourts[teamIndex] = courtCode
      nextLastVenues[teamIndex] = venueCode
    }

    orderScore += getCourtCode(courtPlan.court) * (planIndex + 1) * 0.001
  }

  if (
    !canPlaceRemainingCards(
      nextRemainingCardCounts,
      futureCardAvailabilityCounts,
      slotIndex + 1,
    )
  ) {
    return null
  }

  return {
    remainingCardCounts: nextRemainingCardCounts,
    lastCardSlots: nextLastCardSlots,
    lastCourts: nextLastCourts,
    lastVenues: nextLastVenues,
    previousVenues: nextPreviousVenues,
    teamCourtMoves: nextTeamCourtMoves,
    teamVenueMoves: nextTeamVenueMoves,
    teamVenueRoundTrips: nextTeamVenueRoundTrips,
    lastCourtTeamIndexes: nextLastCourtTeamIndexes,
    repeatsWithin2Slots,
    minRepeatGap,
    oneTeamChangeCount,
    twoTeamChangeCount,
    sameCourtCardRepeatCount,
    orderScore,
    courtPlanSlots: [...state.courtPlanSlots, courtPlans],
  }
}

const createRestLockedOptionScore = (
  state: RestLockedRescheduleState,
  courtPlans: RestLockedCourtPlan[],
  slotIndex: number,
  cardIndexByKey: Map<string, number>,
  venueCodeLookup: Map<ThreeCourtId, number>,
) => {
  const slotNumber = slotIndex + 1
  let score = 0

  for (const courtPlan of courtPlans) {
    const cardIndex = cardIndexByKey.get(courtPlan.cardKey)
    const lastCardSlot = cardIndex === undefined ? 0 : state.lastCardSlots[cardIndex]

    if (lastCardSlot > 0) {
      const gap = slotNumber - lastCardSlot

      if (gap === 2) {
        score += 10_000
      } else if (gap === 3) {
        score += 1_000
      } else if (gap <= 7) {
        score += (8 - gap) * 20
      }
    }

    const courtCode = getCourtCode(courtPlan.court)
    const courtIndex = courtCode - 1
    const previousCourtTeamIndexes = state.lastCourtTeamIndexes[courtIndex]

    if (previousCourtTeamIndexes !== null) {
      const sharedTeamCount = countSharedCourtTeams(
        previousCourtTeamIndexes,
        courtPlan.teamIndexes,
      )

      if (sharedTeamCount === 2) {
        score += 100_000
      } else if (sharedTeamCount === 1) {
        score -= 20
      } else {
        score += 80
      }
    }

    const venueCode = venueCodeLookup.get(courtPlan.court) ?? 1

    for (const teamIndex of courtPlan.teamIndexes) {
      if (state.lastVenues[teamIndex] !== 0 && state.lastVenues[teamIndex] !== venueCode) {
        score += 300
      }

      if (state.lastCourts[teamIndex] !== 0 && state.lastCourts[teamIndex] !== courtCode) {
        score += 20
      }
    }
  }

  return score
}

const findRestLockedNoImmediateCourtPlanSlots = (
  slots: ScheduleSlot[],
  teams: Team[],
  roundCount: number,
  venueLookup: Map<ThreeCourtId, string>,
  forbidVenueRoundTrips: boolean,
) => {
  if (
    slots.length > 30 ||
    teams.length > 8 ||
    slots.some((slot) => slot.courts.some((assignment) => assignment.match === null))
  ) {
    return null
  }

  const activeTeamIndexesBySlot = createActiveTeamIndexesBySlot(slots, teams)

  if (
    activeTeamIndexesBySlot.some(
      (activeTeamIndexes) => activeTeamIndexes.length !== THREE_COURTS.length * 2,
    )
  ) {
    return null
  }

  const teamPairs = createTeamPairIndexes(teams.length)
  const cardIndexByKey = new Map(
    teamPairs.map((teamPair, cardIndex) => [createCardKey(teamPair[0], teamPair[1]), cardIndex]),
  )
  const futureCardAvailabilityCounts = createFutureCardAvailabilityCounts(
    activeTeamIndexesBySlot,
    teamPairs,
  )
  const slotOptions = createRestLockedSlotOptions(activeTeamIndexesBySlot)
  const venueCodeLookup = createVenueCodeLookup(venueLookup)
  let searchNodeCount = 0
  const failedStateKeys = new Set<string>()
  const initialState: RestLockedRescheduleState = {
    remainingCardCounts: Array.from({ length: teamPairs.length }, () => roundCount),
    lastCardSlots: Array.from({ length: teamPairs.length }, () => 0),
    lastCourts: Array.from({ length: teams.length }, () => 0),
    lastVenues: Array.from({ length: teams.length }, () => 0),
    previousVenues: Array.from({ length: teams.length }, () => 0),
    teamCourtMoves: Array.from({ length: teams.length }, () => 0),
    teamVenueMoves: Array.from({ length: teams.length }, () => 0),
    teamVenueRoundTrips: Array.from({ length: teams.length }, () => 0),
    lastCourtTeamIndexes: THREE_COURTS.map(() => null),
    repeatsWithin2Slots: 0,
    minRepeatGap: Number.POSITIVE_INFINITY,
    oneTeamChangeCount: 0,
    twoTeamChangeCount: 0,
    sameCourtCardRepeatCount: 0,
    orderScore: 0,
    courtPlanSlots: [],
  }

  const search = (slotIndex: number, state: RestLockedRescheduleState): RestLockedCourtPlan[][] | null => {
    searchNodeCount += 1

    if (searchNodeCount > REST_LOCKED_RESCHEDULE_NODE_LIMIT) {
      return null
    }

    if (slotIndex === slots.length) {
      return state.remainingCardCounts.every((remainingCount) => remainingCount === 0)
        ? state.courtPlanSlots
        : null
    }

    const memoKey = createRestLockedMemoKey(slotIndex, state)
    if (failedStateKeys.has(memoKey)) {
      return null
    }

    const nextStates = slotOptions[slotIndex]
      .map((courtPlans) => ({
        courtPlans,
        state: createNextRestLockedState(
          state,
          courtPlans,
          slotIndex,
          cardIndexByKey,
          futureCardAvailabilityCounts,
          venueCodeLookup,
          forbidVenueRoundTrips,
        ),
        optionScore: createRestLockedOptionScore(
          state,
          courtPlans,
          slotIndex,
          cardIndexByKey,
          venueCodeLookup,
        ),
      }))
      .filter(
        (candidate): candidate is {
          courtPlans: RestLockedCourtPlan[]
          state: RestLockedRescheduleState
          optionScore: number
        } => candidate.state !== null,
      )
      .sort((first, second) =>
        first.optionScore - second.optionScore || compareRestLockedStates(first.state, second.state),
      )

    for (const candidate of nextStates) {
      const result = search(slotIndex + 1, candidate.state)

      if (result !== null) {
        return result
      }
    }

    failedStateKeys.add(memoKey)
    return null
  }

  return search(0, initialState)
}

const buildRestLockedScheduleSlots = (
  sourceSlots: ScheduleSlot[],
  teams: Team[],
  courtPlanSlots: RestLockedCourtPlan[][],
): ScheduleSlot[] =>
  sourceSlots.map((sourceSlot, slotIndex) => {
    const courts = THREE_COURTS.map((court) => {
      const courtPlan = courtPlanSlots[slotIndex]?.find((plan) => plan.court === court)

      if (courtPlan === undefined) {
        return createEmptyAssignment(court)
      }

      return {
        court,
        match: {
          id: `rescheduled-${sourceSlot.slotNumber}-${court}`,
          teamA: teams[courtPlan.teamIndexes[0]],
          teamB: teams[courtPlan.teamIndexes[1]],
          cardKey: courtPlan.cardKey,
        },
      }
    })
    const slot = {
      slotNumber: sourceSlot.slotNumber,
      courts,
      restingTeams: sourceSlot.restingTeams,
    }

    return {
      ...slot,
      restingTeams: rebuildRestingTeams(slot, teams),
    }
  })

const rebalanceImmediateCardRematches = (
  slots: ScheduleSlot[],
  teams: Team[],
  roundCount: number,
  venueLookup: Map<ThreeCourtId, string>,
) => {
  const baselineQuality = calculateScheduleQuality(slots, teams, venueLookup)

  if (baselineQuality.sameCardConsecutiveCount === 0) {
    return slots
  }

  const courtPlanSlots = findRestLockedNoImmediateCourtPlanSlots(
    slots,
    teams,
    roundCount,
    venueLookup,
    baselineQuality.totalVenueRoundTrips === 0,
  )

  if (courtPlanSlots === null) {
    return slots
  }

  const candidateSlots = buildRestLockedScheduleSlots(slots, teams, courtPlanSlots)
  const candidateQuality = calculateScheduleQuality(candidateSlots, teams, venueLookup)

  if (
    candidateQuality.sameCardConsecutiveCount < baselineQuality.sameCardConsecutiveCount &&
    keepsCriticalQuality(candidateQuality, baselineQuality)
  ) {
    return candidateSlots
  }

  return slots
}

const optimizeScheduleCardSpacing = (
  slots: ScheduleSlot[],
  teams: Team[],
  venueLookup: Map<ThreeCourtId, string>,
) => {
  const baselineQuality = calculateScheduleQuality(slots, teams, venueLookup)
  let currentSlots = slots
  let currentQuality = baselineQuality

  for (let pass = 0; pass < 6; pass += 1) {
    let bestSlots = currentSlots
    let bestQuality = currentQuality

    for (let firstSlotIndex = 0; firstSlotIndex < currentSlots.length - 1; firstSlotIndex += 1) {
      for (let firstCourtIndex = 0; firstCourtIndex < currentSlots[firstSlotIndex].courts.length; firstCourtIndex += 1) {
        const firstAssignment = currentSlots[firstSlotIndex].courts[firstCourtIndex]
        if (firstAssignment.match === null) {
          continue
        }

        for (let secondSlotIndex = firstSlotIndex + 1; secondSlotIndex < currentSlots.length; secondSlotIndex += 1) {
          for (let secondCourtIndex = 0; secondCourtIndex < currentSlots[secondSlotIndex].courts.length; secondCourtIndex += 1) {
            const secondAssignment = currentSlots[secondSlotIndex].courts[secondCourtIndex]
            if (secondAssignment.match === null) {
              continue
            }

            const candidateSlots = cloneScheduleSlots(currentSlots)
            const candidateFirstAssignment = candidateSlots[firstSlotIndex].courts[firstCourtIndex]
            const candidateSecondAssignment = candidateSlots[secondSlotIndex].courts[secondCourtIndex]
            const firstMatch = candidateFirstAssignment.match

            candidateFirstAssignment.match = candidateSecondAssignment.match
            candidateSecondAssignment.match = firstMatch

            const firstSlot = candidateSlots[firstSlotIndex]
            const secondSlot = candidateSlots[secondSlotIndex]
            if (hasSlotTeamDuplication(firstSlot) || hasSlotTeamDuplication(secondSlot)) {
              continue
            }

            firstSlot.restingTeams = rebuildRestingTeams(firstSlot, teams)
            secondSlot.restingTeams = rebuildRestingTeams(secondSlot, teams)

            const candidateQuality = calculateScheduleQuality(candidateSlots, teams, venueLookup)
            if (!keepsCriticalQuality(candidateQuality, baselineQuality)) {
              continue
            }

            if (candidateQuality.score < bestQuality.score) {
              bestSlots = candidateSlots
              bestQuality = candidateQuality
            }
          }
        }
      }
    }

    if (bestSlots === currentSlots) {
      break
    }

    currentSlots = bestSlots
    currentQuality = bestQuality
  }

  return currentSlots
}

export const generateThreeCourtSchedule = ({
  courtCount,
  roundCount,
  teamNames,
  courtVenues,
}: ScheduleGenerationInput): ScheduleGenerationResult => {
  if (courtCount !== 3) {
    throw new Error('3コートの組み合わせ生成には、コート数を3にしてください。')
  }

  if (roundCount < 1) {
    throw new Error('周回数は1以上で指定してください。')
  }

  if (teamNames.length < 6) {
    throw new Error('3コートでは6チーム以上を指定してください。')
  }

  const teams = normalizeTeamNames(teamNames)
  const normalizedCourtVenues = normalizeCourtVenues(courtVenues)
  const venueLookup = createVenueLookup(normalizedCourtVenues)

  if (isAlwaysActiveTeamCount(courtCount, teams.length)) {
    const slots = createAlwaysActiveScheduleSlots(teams, roundCount, venueLookup)

    return {
      courtCount: 3,
      roundCount,
      teams,
      slots,
      totalMatches: slots.reduce(
        (total, slot) => total + slot.courts.filter((assignment) => assignment.match !== null).length,
        0,
      ),
      courtVenues: normalizedCourtVenues,
    }
  }

  const pendingMatches = createPendingMatches(teams.length, roundCount)
  const teamStates = createTeamStates(teams.length)
  const lastCardSlots = new Map<string, number>()
  const previousCourtTeamIndexes = createInitialPreviousCourtTeamIndexes()
  const slots: ScheduleSlot[] = []

  while (pendingMatches.length > 0) {
    const slotNumber = slots.length + 1
    const slotPlan = chooseMatchesForSlot(
      pendingMatches,
      teamStates,
      lastCardSlots,
      slotNumber,
      venueLookup,
      previousCourtTeamIndexes,
    )
    const courtAssignments = buildCourtAssignments(pendingMatches, slotPlan.courtPlans, teams)
    const playingTeamIndexes = collectPlayingTeamIndexes(
      slotPlan.selectedIndexes.map((selectedIndex) => pendingMatches[selectedIndex]),
    )
    const restingTeams = teams.filter((_, teamIndex) => !playingTeamIndexes.has(teamIndex))

    slots.push({
      slotNumber,
      courts: courtAssignments,
      restingTeams,
    })

    updateScheduleState(
      pendingMatches,
      slotPlan.courtPlans,
      teamStates,
      lastCardSlots,
      slotNumber,
      venueLookup,
    )
    updatePreviousCourtTeamIndexes(
      previousCourtTeamIndexes,
      pendingMatches,
      slotPlan.courtPlans,
    )
    removeSelectedMatches(pendingMatches, slotPlan.selectedIndexes)
  }

  const optimizedSlots = optimizeScheduleCardSpacing(slots, teams, venueLookup)
  const rebalancedSlots = rebalanceImmediateCardRematches(
    optimizedSlots,
    teams,
    roundCount,
    venueLookup,
  )
  const finalSlots = optimizeScheduleCardSpacing(rebalancedSlots, teams, venueLookup)

  return {
    courtCount: 3,
    roundCount,
    teams,
    slots: finalSlots,
    totalMatches: finalSlots.reduce(
      (total, slot) => total + slot.courts.filter((assignment) => assignment.match !== null).length,
      0,
    ),
    courtVenues: normalizedCourtVenues,
  }
}
