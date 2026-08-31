import type { Team } from './types'

export const normalizeTeamNames = (teamNames: string[]): Team[] =>
  teamNames.map((teamName, index) => {
    const trimmedName = teamName.trim()
    const teamNumber = index + 1

    return {
      id: 'team-' + String(teamNumber),
      name: trimmedName.length > 0 ? trimmedName : 'チーム ' + String(teamNumber),
      order: teamNumber,
    }
  })
