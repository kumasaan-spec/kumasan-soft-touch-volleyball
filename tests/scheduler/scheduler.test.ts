import assert from 'node:assert/strict'
import { test } from 'node:test'

import { generateOneCourtSchedule } from '../../src/scheduler/generateOneCourtSchedule'
import { generateFourCourtSchedule } from '../../src/scheduler/generateFourCourtSchedule'
import { generateThreeCourtSchedule } from '../../src/scheduler/generateThreeCourtSchedule'
import { generateTwoCourtSchedule } from '../../src/scheduler/generateTwoCourtSchedule'
import type {
  CourtId,
  CourtVenueSetting,
  ScheduleGenerationInput,
  ScheduleGenerationResult,
  ScheduleMatch,
  ScheduleSlot,
  Team,
} from '../../src/scheduler/types'

type Generator = (input: ScheduleGenerationInput) => ScheduleGenerationResult

type Metrics = {
  totalMatches: number
  slotCount: number
  expectedEmptyCourts: number
  unnecessaryEmptyCourts: number
  duplicateTeamSlotCount: number
  incorrectCardCounts: string[]
  playCounts: Record<string, number>
  restCounts: Record<string, number>
  maxPlayStreaks: Record<string, number>
  maxRestStreaks: Record<string, number>
  sameCardConsecutiveCount: number
  minRepeatGap: number | null
  repeatsWithin2Slots: number
  courtMoves: Record<string, number>
  venueMoves: Record<string, number>
  venueRoundTrips: Record<string, number>
  oneTeamChangeCount: number
  twoTeamChangeCount: number
  sameCourtCardConsecutiveCount: number
}

type CaseDefinition = {
  name: string
  courtCount: 1 | 2 | 3 | 4
  teamCount: number
  roundCount: number
  generator: Generator
  courtVenues?: CourtVenueSetting[]
  expectations?: {
    maxPlayStreak?: number
    maxRestStreak?: number
    restCount?: number
    minRepeatGap?: number
    venueRoundTrips?: number
  }
}

const createTeamNames = (teamCount: number) =>
  Array.from({ length: teamCount }, (_, index) => `チーム${index + 1}`)

const createInput = (caseDefinition: CaseDefinition): ScheduleGenerationInput => ({
  courtCount: caseDefinition.courtCount,
  roundCount: caseDefinition.roundCount,
  teamNames: createTeamNames(caseDefinition.teamCount),
  courtVenues: caseDefinition.courtVenues,
})

const createCardKey = (firstTeam: Team, secondTeam: Team) =>
  [firstTeam.id, secondTeam.id].sort().join('::')

const matchToCardKey = (match: ScheduleMatch) => createCardKey(match.teamA, match.teamB)

const getSlotCardKeys = (slot: ScheduleSlot) =>
  slot.courts
    .map((court) => court.match)
    .filter((match): match is ScheduleMatch => match !== null)
    .map(matchToCardKey)

const createExpectedCardCounts = (teams: Team[], roundCount: number) => {
  const expectedCounts = new Map<string, number>()

  for (let firstIndex = 0; firstIndex < teams.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < teams.length; secondIndex += 1) {
      expectedCounts.set(createCardKey(teams[firstIndex], teams[secondIndex]), roundCount)
    }
  }

  return expectedCounts
}

const countCourtTurnover = (
  previousMatch: ScheduleMatch | null,
  nextMatch: ScheduleMatch | null,
) => {
  if (previousMatch === null || nextMatch === null) {
    return null
  }

  const previousTeamIds = [previousMatch.teamA.id, previousMatch.teamB.id]
  const nextTeamIds = [nextMatch.teamA.id, nextMatch.teamB.id]
  const sharedTeamCount = nextTeamIds.filter((teamId) => previousTeamIds.includes(teamId)).length

  if (sharedTeamCount === 1) {
    return 'one'
  }

  if (sharedTeamCount === 0) {
    return 'two'
  }

  return 'same'
}

const analyzeSchedule = (result: ScheduleGenerationResult): Metrics => {
  const teamIds = result.teams.map((team) => team.id)
  const playCounts = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const restCounts = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const currentPlayStreaks = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const currentRestStreaks = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const maxPlayStreaks = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const maxRestStreaks = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const courtMoves = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const venueMoves = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const venueRoundTrips = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]))
  const lastCourts = new Map<string, CourtId>()
  const lastVenues = new Map<string, string>()
  const venueHistories = new Map(teamIds.map((teamId) => [teamId, [] as string[]]))
  const actualCardCounts = new Map<string, number>()
  const lastCardSlots = new Map<string, number>()
  const venueLookup = new Map(
    (result.courtVenues ?? []).map((setting) => [setting.court, setting.venueName] as const),
  )
  const previousCourtMatches = new Map<CourtId, ScheduleMatch | null>()

  let totalMatches = 0
  let duplicateTeamSlotCount = 0
  let sameCardConsecutiveCount = 0
  let minRepeatGap: number | null = null
  let repeatsWithin2Slots = 0
  let oneTeamChangeCount = 0
  let twoTeamChangeCount = 0
  let sameCourtCardConsecutiveCount = 0

  for (const slot of result.slots) {
    const playingTeamIds = new Set<string>()
    const courtByTeam = new Map<string, CourtId>()
    const venueByTeam = new Map<string, string>()
    const slotCardKeys = new Set<string>()

    for (const assignment of slot.courts) {
      if (assignment.match === null) {
        previousCourtMatches.set(assignment.court, null)
        continue
      }

      const { match } = assignment
      const cardKey = matchToCardKey(match)
      const previousSlot = lastCardSlots.get(cardKey)
      const previousMatch = previousCourtMatches.get(assignment.court) ?? null
      const turnover = countCourtTurnover(previousMatch, match)

      totalMatches += 1
      actualCardCounts.set(cardKey, (actualCardCounts.get(cardKey) ?? 0) + 1)

      if (previousSlot !== undefined) {
        const gap = slot.slotNumber - previousSlot
        minRepeatGap = minRepeatGap === null ? gap : Math.min(minRepeatGap, gap)

        if (gap === 1) {
          sameCardConsecutiveCount += 1
        }

        if (gap <= 2) {
          repeatsWithin2Slots += 1
        }
      }

      if (previousMatch !== null && matchToCardKey(previousMatch) === cardKey) {
        sameCourtCardConsecutiveCount += 1
      }

      if (turnover === 'one') {
        oneTeamChangeCount += 1
      } else if (turnover === 'two') {
        twoTeamChangeCount += 1
      }

      for (const team of [match.teamA, match.teamB]) {
        if (playingTeamIds.has(team.id)) {
          duplicateTeamSlotCount += 1
        }

        playingTeamIds.add(team.id)

        courtByTeam.set(team.id, assignment.court)
        venueByTeam.set(team.id, venueLookup.get(assignment.court) ?? '会場1')
      }

      slotCardKeys.add(cardKey)
      previousCourtMatches.set(assignment.court, match)
      lastCardSlots.set(cardKey, slot.slotNumber)
    }

    if (slotCardKeys.size !== getSlotCardKeys(slot).length) {
      duplicateTeamSlotCount += 1
    }

    for (const team of result.teams) {
      const court = courtByTeam.get(team.id)
      const venueName = venueByTeam.get(team.id)

      if (court !== undefined && venueName !== undefined) {
        playCounts[team.id] += 1
        currentPlayStreaks[team.id] += 1
        currentRestStreaks[team.id] = 0
        maxPlayStreaks[team.id] = Math.max(maxPlayStreaks[team.id], currentPlayStreaks[team.id])

        const previousCourt = lastCourts.get(team.id)
        if (previousCourt !== undefined && previousCourt !== court) {
          courtMoves[team.id] += 1
        }

        const previousVenue = lastVenues.get(team.id)
        if (previousVenue !== undefined && previousVenue !== venueName) {
          venueMoves[team.id] += 1
        }

        const venueHistory = venueHistories.get(team.id)
        assert.ok(venueHistory !== undefined)
        venueHistory.push(venueName)

        if (venueHistory.length >= 3) {
          const lastIndex = venueHistory.length - 1
          if (
            venueHistory[lastIndex] === venueHistory[lastIndex - 2] &&
            venueHistory[lastIndex] !== venueHistory[lastIndex - 1]
          ) {
            venueRoundTrips[team.id] += 1
          }
        }

        lastCourts.set(team.id, court)
        lastVenues.set(team.id, venueName)
        continue
      }

      restCounts[team.id] += 1
      currentRestStreaks[team.id] += 1
      currentPlayStreaks[team.id] = 0
      maxRestStreaks[team.id] = Math.max(maxRestStreaks[team.id], currentRestStreaks[team.id])
    }
  }

  const expectedCardCounts = createExpectedCardCounts(result.teams, result.roundCount)
  const incorrectCardCounts: string[] = []

  for (const [cardKey, expectedCount] of expectedCardCounts) {
    if ((actualCardCounts.get(cardKey) ?? 0) !== expectedCount) {
      incorrectCardCounts.push(cardKey)
    }
  }

  for (const cardKey of actualCardCounts.keys()) {
    if (!expectedCardCounts.has(cardKey)) {
      incorrectCardCounts.push(cardKey)
    }
  }

  const maxUsableCourtCount = Math.min(result.courtCount, Math.floor(result.teams.length / 2))
  const expectedEmptyCourts =
    Math.ceil(totalMatches / maxUsableCourtCount) * maxUsableCourtCount - totalMatches
  const actualEmptyCourts = result.slots.reduce(
    (count, slot) => count + slot.courts.filter((assignment) => assignment.match === null).length,
    0,
  )

  return {
    totalMatches,
    slotCount: result.slots.length,
    expectedEmptyCourts,
    unnecessaryEmptyCourts: Math.max(0, actualEmptyCourts - expectedEmptyCourts),
    duplicateTeamSlotCount,
    incorrectCardCounts,
    playCounts,
    restCounts,
    maxPlayStreaks,
    maxRestStreaks,
    sameCardConsecutiveCount,
    minRepeatGap,
    repeatsWithin2Slots,
    courtMoves,
    venueMoves,
    venueRoundTrips,
    oneTeamChangeCount,
    twoTeamChangeCount,
    sameCourtCardConsecutiveCount,
  }
}

const maxValue = (values: Record<string, number>) => Math.max(...Object.values(values))

const assertBaseQuality = (result: ScheduleGenerationResult, metrics: Metrics) => {
  const expectedTotalMatches =
    (result.teams.length * (result.teams.length - 1) * result.roundCount) / 2
  const expectedMatchesPerTeam = (result.teams.length - 1) * result.roundCount
  const expectedRestsPerTeam = result.slots.length - expectedMatchesPerTeam

  assert.equal(metrics.totalMatches, expectedTotalMatches)
  assert.equal(result.totalMatches, expectedTotalMatches)
  assert.equal(metrics.duplicateTeamSlotCount, 0)
  assert.equal(metrics.unnecessaryEmptyCourts, 0)
  assert.deepEqual(metrics.incorrectCardCounts, [])
  assert.equal(metrics.sameCardConsecutiveCount, 0)

  for (const team of result.teams) {
    assert.equal(metrics.playCounts[team.id], expectedMatchesPerTeam)
    assert.equal(metrics.restCounts[team.id], expectedRestsPerTeam)
  }
}

const assertSpecificQuality = (
  caseDefinition: CaseDefinition,
  metrics: Metrics,
) => {
  const { expectations } = caseDefinition

  if (expectations?.maxPlayStreak !== undefined) {
    assert.ok(maxValue(metrics.maxPlayStreaks) <= expectations.maxPlayStreak)
  }

  if (expectations?.maxRestStreak !== undefined) {
    assert.ok(maxValue(metrics.maxRestStreaks) <= expectations.maxRestStreak)
  }

  if (expectations?.restCount !== undefined) {
    for (const restCount of Object.values(metrics.restCounts)) {
      assert.equal(restCount, expectations.restCount)
    }
  }

  if (expectations?.minRepeatGap !== undefined) {
    assert.ok(metrics.minRepeatGap !== null)
    assert.ok(metrics.minRepeatGap >= expectations.minRepeatGap)
  }

  if (expectations?.venueRoundTrips !== undefined) {
    const totalVenueRoundTrips = Object.values(metrics.venueRoundTrips).reduce(
      (total, count) => total + count,
      0,
    )
    assert.equal(totalVenueRoundTrips, expectations.venueRoundTrips)
  }
}

const oneVenueThreeCourts: CourtVenueSetting[] = [
  { court: 'A', venueName: '会場1' },
  { court: 'B', venueName: '会場1' },
  { court: 'C', venueName: '会場1' },
]

const twoVenueThreeCourts: CourtVenueSetting[] = [
  { court: 'A', venueName: '会場1' },
  { court: 'B', venueName: '会場1' },
  { court: 'C', venueName: '会場2' },
]

const oneVenueFourCourts: CourtVenueSetting[] = [
  { court: 'A', venueName: '会場1' },
  { court: 'B', venueName: '会場1' },
  { court: 'C', venueName: '会場1' },
  { court: 'D', venueName: '会場1' },
]

const twoVenueFourCourts: CourtVenueSetting[] = [
  { court: 'A', venueName: '会場1' },
  { court: 'B', venueName: '会場1' },
  { court: 'C', venueName: '会場2' },
  { court: 'D', venueName: '会場2' },
]

const cases: CaseDefinition[] = [
  {
    name: '1コート / 3チーム / 3周',
    courtCount: 1,
    teamCount: 3,
    roundCount: 3,
    generator: generateOneCourtSchedule,
  },
  {
    name: '1コート / 6チーム / 3周',
    courtCount: 1,
    teamCount: 6,
    roundCount: 3,
    generator: generateOneCourtSchedule,
  },
  {
    name: '2コート / 4チーム / 3周',
    courtCount: 2,
    teamCount: 4,
    roundCount: 3,
    generator: generateTwoCourtSchedule,
  },
  {
    name: '2コート / 5チーム / 3周',
    courtCount: 2,
    teamCount: 5,
    roundCount: 3,
    generator: generateTwoCourtSchedule,
  },
  {
    name: '2コート / 6チーム / 3周',
    courtCount: 2,
    teamCount: 6,
    roundCount: 3,
    generator: generateTwoCourtSchedule,
    expectations: {
      maxPlayStreak: 2,
      maxRestStreak: 1,
      minRepeatGap: 5,
    },
  },
  {
    name: '3コート / 6チーム / 3周 / 全会場1',
    courtCount: 3,
    teamCount: 6,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: oneVenueThreeCourts,
    expectations: {
      minRepeatGap: 5,
    },
  },
  {
    name: '3コート / 6チーム / 3周 / 2会場',
    courtCount: 3,
    teamCount: 6,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: twoVenueThreeCourts,
    expectations: {
      minRepeatGap: 5,
    },
  },
  {
    name: '3コート / 7チーム / 3周 / 全会場1',
    courtCount: 3,
    teamCount: 7,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: oneVenueThreeCourts,
  },
  {
    name: '3コート / 7チーム / 3周 / 2会場',
    courtCount: 3,
    teamCount: 7,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: twoVenueThreeCourts,
    expectations: {
      maxPlayStreak: 6,
      maxRestStreak: 1,
      restCount: 3,
    },
  },
  {
    name: '3コート / 8チーム / 3周 / 全会場1',
    courtCount: 3,
    teamCount: 8,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: oneVenueThreeCourts,
  },

  {
    name: '4コート / 8チーム / 1周 / 全会場1',
    courtCount: 4,
    teamCount: 8,
    roundCount: 1,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 8チーム / 2周 / 全会場1',
    courtCount: 4,
    teamCount: 8,
    roundCount: 2,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 8チーム / 3周 / 全会場1',
    courtCount: 4,
    teamCount: 8,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 8チーム / 3周 / 2会場',
    courtCount: 4,
    teamCount: 8,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: twoVenueFourCourts,
  },
  {
    name: '4コート / 9チーム / 1周 / 全会場1',
    courtCount: 4,
    teamCount: 9,
    roundCount: 1,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 9チーム / 2周 / 全会場1',
    courtCount: 4,
    teamCount: 9,
    roundCount: 2,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 9チーム / 3周 / 全会場1',
    courtCount: 4,
    teamCount: 9,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 10チーム / 1周 / 全会場1',
    courtCount: 4,
    teamCount: 10,
    roundCount: 1,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 10チーム / 2周 / 全会場1',
    courtCount: 4,
    teamCount: 10,
    roundCount: 2,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 10チーム / 3周 / 全会場1',
    courtCount: 4,
    teamCount: 10,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 10チーム / 3周 / 2会場',
    courtCount: 4,
    teamCount: 10,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: twoVenueFourCourts,
  },
  {
    name: '4コート / 11チーム / 3周 / 全会場1',
    courtCount: 4,
    teamCount: 11,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '4コート / 12チーム / 3周 / 全会場1',
    courtCount: 4,
    teamCount: 12,
    roundCount: 3,
    generator: generateFourCourtSchedule,
    courtVenues: oneVenueFourCourts,
  },
  {
    name: '3コート / 8チーム / 3周 / 2会場',
    courtCount: 3,
    teamCount: 8,
    roundCount: 3,
    generator: generateThreeCourtSchedule,
    courtVenues: twoVenueThreeCourts,
    expectations: {
      maxPlayStreak: 3,
      maxRestStreak: 1,
      restCount: 7,
      venueRoundTrips: 0,
    },
  },
]

test('scheduler outputs satisfy matchup quality invariants', () => {
  for (const caseDefinition of cases) {
    const input = createInput(caseDefinition)
    const firstResult = caseDefinition.generator(input)
    const secondResult = caseDefinition.generator(input)
    const metrics = analyzeSchedule(firstResult)

    assert.deepEqual(secondResult, firstResult, caseDefinition.name + ' should be deterministic')
    assertBaseQuality(firstResult, metrics)
    assertSpecificQuality(caseDefinition, metrics)
  }
})
