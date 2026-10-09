/**
 * Which card the one-at-a-time carousel shows after the list of card ids changed: a newly added card is jumped to
 * (unless the list was empty, e.g. while loading), otherwise the index is just kept within range.
 */
export function carouselIndex(prevIds: string[], ids: string[], index: number): number {
  const last = Math.max(0, ids.length - 1);
  if (prevIds.length > 0) {
    const added = ids.findIndex((id) => !prevIds.includes(id));
    if (added !== -1) return added;
  }
  return Math.min(Math.max(0, index), last);
}
