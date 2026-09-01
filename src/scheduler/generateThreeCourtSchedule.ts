import { createCardKey, createRoundRobinPairs } from './roundRobin'
import { normalizeTeamNames } from './teamUtils'
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

type SlotPlan = {
  selectedIndexes: number[]
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
      score -= 8_000
    } else if (teamState.currentPlayStreak === 4) {
      score -= 5_200
    } else if (teamState.currentPlayStreak === 3) {
      score -= 2_600
    } else if (teamState.currentPlayStreak === 2) {
      score -= 600
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
      score += 22_000 + (nextPlayStreak - 6) * 6_000
    } else if (nextPlayStreak === 5) {
      score += 12_000
    } else if (nextPlayStreak === 4) {
      score += 6_000
    } else if (nextPlayStreak === 3) {
      score += 1_000
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
) => {
  const options = createCourtPlanOptions(selectedIndexes)
  let bestCourtPlans = options[0]
  let bestScore = Number.POSITIVE_INFINITY

  for (const option of options) {
    let optionScore = 0

    for (const courtPlan of option) {
      const match = pendingMatches[courtPlan.selectedIndex]
      const venueName = venueLookup.get(courtPlan.court) ?? DEFAULT_VENUE_NAME

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
): SlotPlan => {
  const selectedMatches = selectedIndexes.map((selectedIndex) => pendingMatches[selectedIndex])
  const courtPlanResult = scoreCourtPlans(selectedIndexes, pendingMatches, teamStates, venueLookup)
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
  requiredFullMatchCount: number | null,
) => {
  const matches = indexes.map((index) => pendingMatches[index])

  if (hasAnyTeamOverlap(matches)) {
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
) => {
  const targetMatchCount = Math.min(
    THREE_COURTS.length,
    Math.floor(teamStates.length / 2),
    pendingMatches.length,
  )

  for (let matchCount = targetMatchCount; matchCount >= 1; matchCount -= 1) {
    const candidateWindowSize = Math.min(CANDIDATE_WINDOW_SIZE, pendingMatches.length)
    const candidatePlan = findBestPlanForMatchCount(
      pendingMatches,
      teamStates,
      lastCardSlots,
      slotNumber,
      venueLookup,
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
      matchCount,
      fallbackWindowSize,
      matchCount === targetMatchCount ? targetMatchCount : null,
    )

    if (fallbackPlan !== null) {
      return fallbackPlan
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
  let sameCardConsecutiveCount = 0
  let repeatsWithin2Slots = 0
  let minRepeatGap: number | null = null

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
    sameCardConsecutiveCount * 320_000 +
    repeatsWithin2Slots * 72_000 +
    totalVenueRoundTrips * 220_000 +
    totalVenueMoves * 520 +
    totalCourtMoves * 70

  return {
    score,
    invalidSlotCount,
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
  candidate.repeatsWithin2Slots <= baseline.repeatsWithin2Slots &&
  candidate.totalVenueRoundTrips <= baseline.totalVenueRoundTrips

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
  const pendingMatches = createPendingMatches(teams.length, roundCount)
  const teamStates = createTeamStates(teams.length)
  const lastCardSlots = new Map<string, number>()
  const slots: ScheduleSlot[] = []

  while (pendingMatches.length > 0) {
    const slotNumber = slots.length + 1
    const slotPlan = chooseMatchesForSlot(
      pendingMatches,
      teamStates,
      lastCardSlots,
      slotNumber,
      venueLookup,
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
    removeSelectedMatches(pendingMatches, slotPlan.selectedIndexes)
  }

  const optimizedSlots = optimizeScheduleCardSpacing(slots, teams, venueLookup)

  return {
    courtCount: 3,
    roundCount,
    teams,
    slots: optimizedSlots,
    totalMatches: optimizedSlots.reduce(
      (total, slot) => total + slot.courts.filter((assignment) => assignment.match !== null).length,
      0,
    ),
    courtVenues: normalizedCourtVenues,
  }
}
