/**
 * Answer scrolling:
 * The answer box keeps the top of the card (the VERDICT headline) in view
 * while it streams, unless the rep has scrolled down near the bottom.
 *
 * @param {{scrollHeight?: number, scrollTop?: number, clientHeight?: number}} box
 * @returns {boolean}
 */
export function shouldFollow(box) {
  const scrollHeight = Number(box?.scrollHeight ?? 0);
  const scrollTop = Number(box?.scrollTop ?? 0);
  const clientHeight = Number(box?.clientHeight ?? 0);
  return (
    scrollHeight > clientHeight + 4 &&
    scrollTop > 0 &&
    scrollHeight - scrollTop - clientHeight < 24
  );
}
