// Compute the settled scrollTop target for the focused lyric row, discounting
// the height of any non-focused instrumental break rows that are still
// mid-collapse in CSS height transitions. Without this, moving focus out of a
// break scrolls past the gap's uncollapsed height while the gap also shrinks
// to 0, pushing the newly focused line upward out of the viewport.
export function collapsingGapHeights(lines, rowsByIndex, focusIdx) {
  let above = 0
  let total = 0
  if (!Array.isArray(lines) || !rowsByIndex) return { above, total }
  for (let i = 0; i < lines.length; i++) {
    if (i === focusIdx || !lines[i]?.gap) continue
    const height = rowsByIndex.get(i)?.rowEl?.offsetHeight || 0
    if (height <= 0) continue
    total += height
    if (i < focusIdx) above += height
  }
  return { above, total }
}

export function focusedScrollTarget({
  rowOffsetTop,
  clientHeight,
  scrollHeight,
  anchorFraction,
  collapsingAbove = 0,
  collapsingTotal = collapsingAbove,
}) {
  const settledOffsetTop = Math.max(0, rowOffsetTop - collapsingAbove)
  const settledScrollHeight = Math.max(0, scrollHeight - collapsingTotal)
  const maxScroll = Math.max(0, settledScrollHeight - clientHeight)
  return Math.min(maxScroll, Math.max(0, settledOffsetTop - clientHeight * anchorFraction))
}
