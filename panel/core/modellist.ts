/**
 * Model-picker ordering: highest arena.ai agent/code net improvement first,
 * then model ID. Only the leaderboard score sorts; models the leaderboard does
 * not list sink below the scored ones instead of interleaving with them.
 */
import type { ModelOption } from '../../service/models';

export const sortModelOptions = (options: ModelOption[]): ModelOption[] =>
  [...options].sort((left, right) => {
    const leftScore = left.arena?.score ?? Number.NEGATIVE_INFINITY;
    const rightScore = right.arena?.score ?? Number.NEGATIVE_INFINITY;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.id.localeCompare(right.id);
  });
