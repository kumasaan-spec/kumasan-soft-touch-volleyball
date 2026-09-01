export type RoundRobinPair = readonly [number, number]

const BYE_TEAM_INDEX = -1

export const createCardKey = (teamAIndex: number, teamBIndex: number) => {
  const first = Math.min(teamAIndex, teamBIndex)
  const second = Math.max(teamAIndex, teamBIndex)

  return String(first) + '-' + String(second)
}

const rotateParticipants = (participants: number[]) => {
  const fixed = participants[0]
  const rest = participants.slice(1)
  const last = rest.pop()

  return [fixed, last, ...rest].filter(
    (participant): participant is number => typeof participant === 'number',
  )
}

export const createRoundRobinRounds = (teamCount: number): RoundRobinPair[][] => {
  const participants = Array.from({ length: teamCount }, (_, index) => index)

  if (participants.length % 2 === 1) {
    participants.push(BYE_TEAM_INDEX)
  }

  const rounds: RoundRobinPair[][] = []
  let rotatingParticipants = participants
  const roundCount = rotatingParticipants.length - 1
  const matchesPerRound = rotatingParticipants.length / 2

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const roundPairs: RoundRobinPair[] = []

    for (let pairIndex = 0; pairIndex < matchesPerRound; pairIndex += 1) {
      const first = rotatingParticipants[pairIndex]
      const second = rotatingParticipants[rotatingParticipants.length - 1 - pairIndex]

      if (first !== BYE_TEAM_INDEX && second !== BYE_TEAM_INDEX) {
        roundPairs.push([first, second])
      }
    }

    rounds.push(roundPairs)
    rotatingParticipants = rotateParticipants(rotatingParticipants)
  }

  return rounds
}

export const createRoundRobinPairs = (teamCount: number): RoundRobinPair[] =>
  createRoundRobinRounds(teamCount).flat()
