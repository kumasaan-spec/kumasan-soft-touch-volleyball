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
const OPTIMIZED_SEARCH_MATCH_LIMIT = 45
const OPTIMIZED_SEARCH_VISIT_LIMIT = 120_000
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

type MatchTeamIndexes = Pick<PendingMatch, 'teamAIndex' | 'teamBIndex'>

const hasTeamOverlap = (firstMatch: MatchTeamIndexes, secondMatch: MatchTeamIndexes) =>
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

type SearchCard = {
  cardKey: string
  teamAIndex: number
  teamBIndex: number
  sequence: number
}

type SearchCandidate = {
  selectedIndexes: number[]
  nextPlayStreaks: number[]
  nextRestStreaks: number[]
  nextPlayedCounts: number[]
  nextRestCounts: number[]
  score: number
}

type MatchCourtPlan = {
  matchIndex: number
  court: TwoCourtId
}

type CourtTeamIndexes = readonly [number, number]

type CourtAssignmentSearchState = {
  lastCourts: number[]
  lastCourtTeamIndexes: Array<CourtTeamIndexes | null>
  teamMoves: number[]
  moveCount: number
  oneTeamChangeCount: number
  twoTeamChangeCount: number
  sameCourtCardRepeatCount: number
  orderScore: number
  courtPlans: MatchCourtPlan[][]
}

const scoreCardRepeatGap = (gap: number) => {
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

const scoreCardIntervalsForMatches = (
  selectedMatches: PendingMatch[],
  lastCardSlots: Map<string, number>,
  slotNumber: number,
) => selectedMatches.reduce((score, match) => {
  const lastCardSlot = lastCardSlots.get(match.cardKey)

  if (lastCardSlot === undefined) {
    return score
  }

  return score + scoreCardRepeatGap(slotNumber - lastCardSlot)
}, 0)

const createSearchCards = (pendingMatches: PendingMatch[]) => {
  const cards: SearchCard[] = []
  const counts: number[] = []
  const cardIndexByKey = new Map<string, number>()

  for (const match of pendingMatches) {
    const existingIndex = cardIndexByKey.get(match.cardKey)

    if (existingIndex !== undefined) {
      counts[existingIndex] += 1
      continue
    }

    cardIndexByKey.set(match.cardKey, cards.length)
    cards.push({
      cardKey: match.cardKey,
      teamAIndex: match.teamAIndex,
      teamBIndex: match.teamBIndex,
      sequence: match.sequence,
    })
    counts.push(1)
  }

  return { cards, counts }
}

const countTeamMatches = (
  cards: SearchCard[],
  counts: number[],
  teamCount: number,
) => {
  const teamMatchCounts = Array.from({ length: teamCount }, () => 0)

  cards.forEach((card, cardIndex) => {
    teamMatchCounts[card.teamAIndex] += counts[cardIndex]
    teamMatchCounts[card.teamBIndex] += counts[cardIndex]
  })

  return teamMatchCounts
}

const calculateMinimumMaxStreak = (activeCount: number, breakCount: number) => {
  if (breakCount <= 0) {
    return activeCount
  }

  return Math.max(1, Math.ceil(activeCount / (breakCount + 1)))
}

const isCardTooClose = (
  cardIndex: number,
  lastCardSlots: readonly number[],
  slotNumber: number,
  minimumCardGap: number,
) => {
  const lastCardSlot = lastCardSlots[cardIndex]
  return lastCardSlot > 0 && slotNumber - lastCardSlot < minimumCardGap
}

const collectSearchPlayingTeams = (
  cards: SearchCard[],
  selectedIndexes: readonly number[],
) => {
  const playingTeamIndexes = new Set<number>()

  selectedIndexes.forEach((selectedIndex) => {
    const card = cards[selectedIndex]
    playingTeamIndexes.add(card.teamAIndex)
    playingTeamIndexes.add(card.teamBIndex)
  })

  return playingTeamIndexes
}

const createSearchCandidate = (
  cards: SearchCard[],
  counts: readonly number[],
  selectedIndexes: number[],
  playStreaks: readonly number[],
  restStreaks: readonly number[],
  playedCounts: readonly number[],
  restCounts: readonly number[],
  lastCardSlots: readonly number[],
  slotNumber: number,
  targetMaxPlayStreak: number,
  targetMaxRestStreak: number,
) => {
  const playingTeamIndexes = collectSearchPlayingTeams(cards, selectedIndexes)
  const nextPlayStreaks = playStreaks.map((streak, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? streak + 1 : 0,
  )
  const nextRestStreaks = restStreaks.map((streak, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? 0 : streak + 1,
  )

  if (
    nextPlayStreaks.some((streak) => streak > targetMaxPlayStreak) ||
    nextRestStreaks.some((streak) => streak > targetMaxRestStreak)
  ) {
    return null
  }

  const nextPlayedCounts = playedCounts.map((count, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? count + 1 : count,
  )
  const nextRestCounts = restCounts.map((count, teamIndex) =>
    playingTeamIndexes.has(teamIndex) ? count : count + 1,
  )
  const repeatScore = selectedIndexes.reduce((score, selectedIndex) => {
    const lastCardSlot = lastCardSlots[selectedIndex]

    if (lastCardSlot <= 0) {
      return score
    }

    return score + scoreCardRepeatGap(slotNumber - lastCardSlot)
  }, 0)
  const remainingCountScore = selectedIndexes.reduce(
    (score, selectedIndex) => score - counts[selectedIndex] * 60,
    0,
  )
  const sequenceScore = selectedIndexes.reduce(
    (score, selectedIndex) => score + cards[selectedIndex].sequence * 0.001,
    0,
  )
  const score =
    repeatScore +
    calculateSpread(nextRestCounts) * 520 +
    calculateSpread(nextPlayedCounts) * 120 +
    Math.max(...nextPlayStreaks) * 90 +
    remainingCountScore +
    sequenceScore

  return {
    selectedIndexes,
    nextPlayStreaks,
    nextRestStreaks,
    nextPlayedCounts,
    nextRestCounts,
    score,
  }
}

const createSearchPairCandidates = (
  cards: SearchCard[],
  counts: readonly number[],
  playStreaks: readonly number[],
  restStreaks: readonly number[],
  playedCounts: readonly number[],
  restCounts: readonly number[],
  lastCardSlots: readonly number[],
  slotNumber: number,
  targetMaxPlayStreak: number,
  targetMaxRestStreak: number,
  minimumCardGap: number,
) => {
  const candidates: SearchCandidate[] = []
  const remainingMatchCount = counts.reduce((total, count) => total + count, 0)

  if (remainingMatchCount === 1) {
    const selectedIndex = counts.findIndex((count) => count > 0)

    if (
      selectedIndex >= 0 &&
      !isCardTooClose(selectedIndex, lastCardSlots, slotNumber, minimumCardGap)
    ) {
      const candidate = createSearchCandidate(
        cards,
        counts,
        [selectedIndex],
        playStreaks,
        restStreaks,
        playedCounts,
        restCounts,
        lastCardSlots,
        slotNumber,
        targetMaxPlayStreak,
        targetMaxRestStreak,
      )

      if (candidate !== null) {
        candidates.push(candidate)
      }
    }

    return candidates
  }

  for (let firstIndex = 0; firstIndex < cards.length - 1; firstIndex += 1) {
    if (counts[firstIndex] <= 0 || isCardTooClose(firstIndex, lastCardSlots, slotNumber, minimumCardGap)) {
      continue
    }

    for (let secondIndex = firstIndex + 1; secondIndex < cards.length; secondIndex += 1) {
      if (
        counts[secondIndex] <= 0 ||
        isCardTooClose(secondIndex, lastCardSlots, slotNumber, minimumCardGap) ||
        hasTeamOverlap(cards[firstIndex], cards[secondIndex])
      ) {
        continue
      }

      const candidate = createSearchCandidate(
        cards,
        counts,
        [firstIndex, secondIndex],
        playStreaks,
        restStreaks,
        playedCounts,
        restCounts,
        lastCardSlots,
        slotNumber,
        targetMaxPlayStreak,
        targetMaxRestStreak,
      )

      if (candidate !== null) {
        candidates.push(candidate)
      }
    }
  }

  return candidates.sort((first, second) => first.score - second.score)
}

const createSearchMemoKey = (
  counts: readonly number[],
  playStreaks: readonly number[],
  restStreaks: readonly number[],
  lastCardSlots: readonly number[],
) => [
  counts.join(','),
  playStreaks.join(','),
  restStreaks.join(','),
  lastCardSlots.join(','),
].join('|')

const searchOptimizedCardSlots = (
  cards: SearchCard[],
  counts: number[],
  playStreaks: number[],
  restStreaks: number[],
  playedCounts: number[],
  restCounts: number[],
  lastCardSlots: number[],
  slotNumber: number,
  targetMaxPlayStreak: number,
  targetMaxRestStreak: number,
  minimumCardGap: number,
  memo: Set<string>,
  visitCount: { value: number },
): string[][] | null => {
  visitCount.value += 1

  if (visitCount.value > OPTIMIZED_SEARCH_VISIT_LIMIT) {
    return null
  }

  if (counts.every((count) => count === 0)) {
    return []
  }

  const memoKey = createSearchMemoKey(counts, playStreaks, restStreaks, lastCardSlots)
  if (memo.has(memoKey)) {
    return null
  }

  const candidates = createSearchPairCandidates(
    cards,
    counts,
    playStreaks,
    restStreaks,
    playedCounts,
    restCounts,
    lastCardSlots,
    slotNumber,
    targetMaxPlayStreak,
    targetMaxRestStreak,
    minimumCardGap,
  )

  for (const candidate of candidates) {
    const nextCounts = [...counts]
    const nextLastCardSlots = [...lastCardSlots]

    candidate.selectedIndexes.forEach((selectedIndex) => {
      nextCounts[selectedIndex] -= 1
      nextLastCardSlots[selectedIndex] = slotNumber
    })

    const remainingCardSlots = searchOptimizedCardSlots(
      cards,
      nextCounts,
      candidate.nextPlayStreaks,
      candidate.nextRestStreaks,
      candidate.nextPlayedCounts,
      candidate.nextRestCounts,
      nextLastCardSlots,
      slotNumber + 1,
      targetMaxPlayStreak,
      targetMaxRestStreak,
      minimumCardGap,
      memo,
      visitCount,
    )

    if (remainingCardSlots !== null) {
      return [
        candidate.selectedIndexes.map((selectedIndex) => cards[selectedIndex].cardKey),
        ...remainingCardSlots,
      ]
    }
  }

  memo.add(memoKey)
  return null
}

const createOptimizedCardSlots = (
  pendingMatches: PendingMatch[],
  teamCount: number,
) => {
  if (pendingMatches.length > OPTIMIZED_SEARCH_MATCH_LIMIT) {
    return null
  }

  const { cards, counts } = createSearchCards(pendingMatches)
  const expectedSlotCount = Math.ceil(pendingMatches.length / TWO_COURTS.length)
  const teamMatchCounts = countTeamMatches(cards, counts, teamCount)
  const teamRestCounts = teamMatchCounts.map((matchCount) => expectedSlotCount - matchCount)
  const minimumMaxPlayStreak = Math.max(
    ...teamMatchCounts.map((matchCount, teamIndex) =>
      calculateMinimumMaxStreak(matchCount, teamRestCounts[teamIndex]),
    ),
  )
  const minimumMaxRestStreak = Math.max(
    ...teamRestCounts.map((restCount, teamIndex) =>
      calculateMinimumMaxStreak(restCount, teamMatchCounts[teamIndex]),
    ),
  )

  for (let maxPlayStreak = minimumMaxPlayStreak; maxPlayStreak <= minimumMaxPlayStreak + 2; maxPlayStreak += 1) {
    for (const minimumCardGap of [3, 2]) {
      const result = searchOptimizedCardSlots(
        cards,
        [...counts],
        Array.from({ length: teamCount }, () => 0),
        Array.from({ length: teamCount }, () => 0),
        Array.from({ length: teamCount }, () => 0),
        Array.from({ length: teamCount }, () => 0),
        Array.from({ length: cards.length }, () => 0),
        1,
        maxPlayStreak,
        minimumMaxRestStreak,
        minimumCardGap,
        new Set(),
        { value: 0 },
      )

      if (result !== null) {
        return result
      }
    }
  }

  return null
}

const pickMatchesForCardSlots = (
  cardSlots: string[][],
  sourcePendingMatches: PendingMatch[],
) => {
  const remainingMatches = [...sourcePendingMatches]

  return cardSlots.map((cardKeys) => cardKeys.map((cardKey) => {
    const selectedIndex = remainingMatches.findIndex((match) => match.cardKey === cardKey)

    if (selectedIndex < 0) {
      throw new Error('組み合わせを作成できませんでした。')
    }

    const [selectedMatch] = remainingMatches.splice(selectedIndex, 1)
    return selectedMatch
  }))
}

const createCourtPlanOptions = (selectedMatches: readonly PendingMatch[]): MatchCourtPlan[][] => {
  if (selectedMatches.length === 1) {
    return [
      [{ matchIndex: 0, court: 'A' }],
      [{ matchIndex: 0, court: 'B' }],
    ]
  }

  return [
    [
      { matchIndex: 0, court: 'A' },
      { matchIndex: 1, court: 'B' },
    ],
    [
      { matchIndex: 0, court: 'B' },
      { matchIndex: 1, court: 'A' },
    ],
  ]
}

const getCourtCode = (court: TwoCourtId) => court === 'A' ? 1 : 2

const scoreCourtPlanOrder = (courtPlans: readonly MatchCourtPlan[]) =>
  courtPlans.reduce(
    (score, courtPlan, planIndex) =>
      score + getCourtCode(courtPlan.court) * (planIndex + 1) * 0.001,
    0,
  )

const getMaxTeamMoveCount = (state: CourtAssignmentSearchState) => Math.max(...state.teamMoves)

const getTeamMoveSpread = (state: CourtAssignmentSearchState) =>
  calculateSpread(state.teamMoves)

const getCourtTeamIndexes = (match: PendingMatch): CourtTeamIndexes => [
  match.teamAIndex,
  match.teamBIndex,
]

const countSharedCourtTeams = (
  previousTeams: CourtTeamIndexes,
  nextTeams: CourtTeamIndexes,
) =>
  nextTeams.filter((teamIndex) => previousTeams.includes(teamIndex)).length

const getCourtAssignmentStateSortValues = (state: CourtAssignmentSearchState) => [
  state.sameCourtCardRepeatCount,
  state.twoTeamChangeCount,
  -state.oneTeamChangeCount,
  getMaxTeamMoveCount(state),
  state.moveCount,
  getTeamMoveSpread(state),
  state.orderScore,
]

const compareCourtAssignmentStates = (
  first: CourtAssignmentSearchState,
  second: CourtAssignmentSearchState,
) => {
  const firstValues = getCourtAssignmentStateSortValues(first)
  const secondValues = getCourtAssignmentStateSortValues(second)

  for (let index = 0; index < firstValues.length; index += 1) {
    const difference = firstValues[index] - secondValues[index]

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

const isBetterCourtAssignmentState = (
  candidate: CourtAssignmentSearchState,
  current: CourtAssignmentSearchState,
) => compareCourtAssignmentStates(candidate, current) < 0

const createCourtAssignmentStateKey = (state: CourtAssignmentSearchState) => [
  state.lastCourts.join(','),
  state.lastCourtTeamIndexes
    .map((teamIndexes) => teamIndexes?.join('-') ?? 'empty')
    .join(','),
].join('|')

const createOptimizedCourtPlanSlots = (
  matchSlots: PendingMatch[][],
  teamCount: number,
) => {
  let states = new Map<string, CourtAssignmentSearchState>()
  const initialLastCourts = Array.from({ length: teamCount }, () => 0)
  const initialState: CourtAssignmentSearchState = {
    lastCourts: initialLastCourts,
    lastCourtTeamIndexes: TWO_COURTS.map(() => null),
    teamMoves: Array.from({ length: teamCount }, () => 0),
    moveCount: 0,
    oneTeamChangeCount: 0,
    twoTeamChangeCount: 0,
    sameCourtCardRepeatCount: 0,
    orderScore: 0,
    courtPlans: [],
  }

  states.set(createCourtAssignmentStateKey(initialState), initialState)

  for (const selectedMatches of matchSlots) {
    const nextStates = new Map<string, CourtAssignmentSearchState>()

    for (const state of states.values()) {
      for (const courtPlans of createCourtPlanOptions(selectedMatches)) {
        const nextLastCourts = [...state.lastCourts]
        const nextLastCourtTeamIndexes: Array<CourtTeamIndexes | null> = TWO_COURTS.map(() => null)
        const nextTeamMoves = [...state.teamMoves]
        let moveCount = state.moveCount
        let oneTeamChangeCount = state.oneTeamChangeCount
        let twoTeamChangeCount = state.twoTeamChangeCount
        let sameCourtCardRepeatCount = state.sameCourtCardRepeatCount

        for (const courtPlan of courtPlans) {
          const match = selectedMatches[courtPlan.matchIndex]
          const courtCode = getCourtCode(courtPlan.court)
          const courtIndex = courtCode - 1
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

            if (lastCourt !== 0 && lastCourt !== courtCode) {
              moveCount += 1
              nextTeamMoves[teamIndex] += 1
            }

            nextLastCourts[teamIndex] = courtCode
          }
        }

        const nextState: CourtAssignmentSearchState = {
          lastCourts: nextLastCourts,
          lastCourtTeamIndexes: nextLastCourtTeamIndexes,
          teamMoves: nextTeamMoves,
          moveCount,
          oneTeamChangeCount,
          twoTeamChangeCount,
          sameCourtCardRepeatCount,
          orderScore: state.orderScore + scoreCourtPlanOrder(courtPlans),
          courtPlans: [...state.courtPlans, courtPlans],
        }
        const stateKey = createCourtAssignmentStateKey(nextState)
        const currentState = nextStates.get(stateKey)

        if (
          currentState === undefined ||
          isBetterCourtAssignmentState(nextState, currentState)
        ) {
          nextStates.set(stateKey, nextState)
        }
      }
    }

    states = nextStates
  }

  const [bestState] = [...states.values()].sort(compareCourtAssignmentStates)

  return bestState?.courtPlans ?? []
}

const buildCourtAssignmentsFromMatches = (
  selectedMatches: PendingMatch[],
  courtPlans: MatchCourtPlan[],
  teams: Team[],
): CourtAssignment[] =>
  TWO_COURTS.map((court) => {
    const courtPlan = courtPlans.find((plan) => plan.court === court)

    if (courtPlan === undefined) {
      return createEmptyAssignment(court)
    }

    return {
      court,
      match: toScheduleMatch(selectedMatches[courtPlan.matchIndex], teams),
    }
  })

const buildScheduleFromCardSlots = (
  cardSlots: string[][],
  sourcePendingMatches: PendingMatch[],
  teams: Team[],
) => {
  const matchSlots = pickMatchesForCardSlots(cardSlots, sourcePendingMatches)
  const courtPlanSlots = createOptimizedCourtPlanSlots(matchSlots, teams.length)

  return matchSlots.map((selectedMatches, slotIndex): ScheduleSlot => {
    const courtPlans = courtPlanSlots[slotIndex]
    const playingTeamIndexes = collectPlayingTeamIndexes(selectedMatches)
    const restingTeams = teams.filter((_, teamIndex) => !playingTeamIndexes.has(teamIndex))

    return {
      slotNumber: slotIndex + 1,
      courts: buildCourtAssignmentsFromMatches(selectedMatches, courtPlans, teams),
      restingTeams,
    }
  })
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
) => scoreCardIntervalsForMatches(selectedMatches, lastCardSlots, slotNumber)

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
  const optimizedCardSlots = createOptimizedCardSlots(pendingMatches, teams.length)

  if (optimizedCardSlots !== null) {
    const slots = buildScheduleFromCardSlots(optimizedCardSlots, pendingMatches, teams)

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
