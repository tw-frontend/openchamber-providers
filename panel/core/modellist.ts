/**
 * Model-picker ordering: strongest coding score first, then model ID. The
 * catalog scores only some models, so the unscored ones sink below the scored
 * ones instead of interleaving with them.
 */
import type { ModelOption } from '../../service/models';

export const sortModelOptions = (options: ModelOption[]): ModelOption[] =>
  [...options].sort((left, right) => {
    const leftScore = left.score ?? Number.NEGATIVE_INFINITY;
    const rightScore = right.score ?? Number.NEGATIVE_INFINITY;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.id.localeCompare(right.id);
  });

/** The score as the picker shows it: an em dash when the catalog has none. */
export const modelScoreText = (score?: number): string => {
  if (score === undefined) return '—';
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
};
