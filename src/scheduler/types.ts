export type CourtNumber = 1 | 2 | 3 | 4

export type CourtId = 'A' | 'B' | 'C' | 'D'

export type Team = {
  id: string
  name: string
  order: number
}

export type ScheduleMatch = {
  id: string
  teamA: Team
  teamB: Team
  cardKey: string
}

export type CourtAssignment = {
  court: CourtId
  match: ScheduleMatch | null
}

export type ScheduleSlot = {
  slotNumber: number
  courts: CourtAssignment[]
  restingTeams: Team[]
}

export type ScheduleGenerationInput = {
  courtCount: CourtNumber
  roundCount: number
  teamNames: string[]
}

export type ScheduleGenerationResult = {
  courtCount: CourtNumber
  roundCount: number
  teams: Team[]
  slots: ScheduleSlot[]
  totalMatches: number
}
