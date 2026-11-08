/**
 * Model-picker ordering: strongest Artificial Analysis coding index first,
 * then model ID. Only `coding` sorts: the overall index and the arena ELO sit
 * on other scales and stay display-only. Unscored models sink below the
 * scored ones instead of interleaving with them.
 */
import type { ModelOption } from '../../service/models';

export const sortModelOptions = (options: ModelOption[]): ModelOption[] =>
  [...options].sort((left, right) => {
    const leftScore = left.coding ?? Number.NEGATIVE_INFINITY;
    const rightScore = right.coding ?? Number.NEGATIVE_INFINITY;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.id.localeCompare(right.id);
  });

/** A score as the picker shows it: an em dash when the catalog has none. */
export const modelScoreText = (score?: number): string => {
  if (score === undefined) return '—';
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
};
