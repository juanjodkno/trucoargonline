import { pool, getLocalRankingResults } from '../auth/userService';

export const WIN_POINTS = 3;
export const LOSS_POINTS = -1;
export const TIME_ZONE = 'America/Argentina/Buenos_Aires';

export interface RankingResult {
  roomId: string;
  winnerUsername: string;
  loserUsername: string;
  createdAt: string;
  betPerPlayer?: number;
}

export function weekBounds(now = new Date()) {
  const offset = 3 * 60 * 60 * 1000;
  const local = new Date(now.getTime() - offset);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;

  const start = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceMonday
  ) + offset;

  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 7 * 86400000).toISOString()
  };
}

export function rankResults(
  results: RankingResult[],
  startsAt: string,
  endsAt: string,
  limit = 10
) {
  const players = new Map<string, {
    username: string;
    wins: number;
    losses: number;
    points: number;
    wagered: number;
  }>();

  const seen = new Set<string>();

  for (const result of results) {
    if (!(Number(result.betPerPlayer) > 0)) continue;

    const time = new Date(result.createdAt).getTime();

    if (
      !(time >= Date.parse(startsAt) && time < Date.parse(endsAt)) ||
      seen.has(result.roomId)
    ) continue;

    seen.add(result.roomId);

    for (const [name, won] of [
      [result.winnerUsername, true],
      [result.loserUsername, false]
    ] as const) {
      const username = name.trim().toLowerCase();

      const player = players.get(username) || {
        username,
        wins: 0,
        losses: 0,
        points: 0,
        wagered: 0
      };

      if (won) player.wins++;
      else player.losses++;

      player.points += won ? WIN_POINTS : LOSS_POINTS;
      player.wagered += Number(result.betPerPlayer) || 0;
      players.set(username, player);
    }
  }

  return [...players.values()]
    .sort((a, b) =>
      b.points - a.points ||
      b.wagered - a.wagered ||
      b.wins - a.wins ||
      a.losses - b.losses ||
      (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
    )
    .slice(0, limit)
    .map(({ username, points }) => ({ username, points }));
}

export async function getWeeklyRanking(
  now = new Date(),
  username: string | null = null,
  includePrevious = true
): Promise<any> {
  const bounds = weekBounds(now);
  let players: { username: string; points: number }[];

  if (!process.env.DATABASE_URL) {
    players = rankResults(
      getLocalRankingResults(),
      bounds.startsAt,
      bounds.endsAt,
      Infinity
    );
  } else {
    const result = await pool.query(`
      WITH results AS (
        SELECT winner_username, loser_username, bet_per_player
        FROM match_settlements
        WHERE created_at >= $1::timestamptz
          AND created_at < $2::timestamptz
          AND bet_per_player > 0
      ), appearances AS (
        SELECT
          LOWER(TRIM(winner_username)) AS username,
          1 AS wins,
          0 AS losses,
          bet_per_player
        FROM results

        UNION ALL

        SELECT
          LOWER(TRIM(loser_username)) AS username,
          0 AS wins,
          1 AS losses,
          bet_per_player
        FROM results
      )
      SELECT
        username,
        (
          SUM(wins) * $3::integer +
          SUM(losses) * $4::integer
        )::integer AS points
      FROM appearances
      GROUP BY username
      ORDER BY
        points DESC,
        SUM(bet_per_player) DESC,
        SUM(wins) DESC,
        SUM(losses) ASC,
        username COLLATE "C" ASC
    `, [
      bounds.startsAt,
      bounds.endsAt,
      WIN_POINTS,
      LOSS_POINTS
    ]);

    players = result.rows.map(row => ({
      username: row.username,
      points: Number(row.points)
    }));
  }

  const personalIndex = username
    ? players.findIndex(player => player.username === username)
    : -1;

  const personal = username ? {
    username,
    position: personalIndex < 0 ? null : personalIndex + 1,
    points: personalIndex < 0 ? 0 : players[personalIndex].points
  } : null;

  const previous = includePrevious
    ? await getWeeklyRanking(
        new Date(Date.parse(bounds.startsAt) - 1),
        null,
        false
      )
    : null;

  return {
    personal,
    previous: previous ? {
      startsAt: previous.startsAt,
      endsAt: previous.endsAt,
      players: previous.players.slice(0, 3)
    } : null,
    ...bounds,
    timeZone: TIME_ZONE,
    winPoints: WIN_POINTS,
    lossPoints: LOSS_POINTS,
    modes: 'Solo 1 vs. 1',
    players: players.slice(0, 10)
  };
}