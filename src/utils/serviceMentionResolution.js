"use strict";

// A short alias such as 整骨 must not create a second service when it is
// wholly inside a more specific configured alias such as 小颜整骨.
// Separate mentions remain separate services, and therefore ambiguous.
function termSpans(text, term) {
  const source = String(text || "");
  const needle = String(term || "");
  if (!source || !needle) return [];
  const spans = [];
  let from = 0;
  let index;
  while ((index = source.indexOf(needle, from)) !== -1) {
    spans.push({ start: index, end: index + needle.length });
    from = index + 1;
  }
  return spans;
}

function pruneCoveredServiceMentions(matches) {
  const entries = Array.isArray(matches) ? matches : [];
  return entries.filter((entry, index) => {
    const spans = Array.isArray(entry?.spans) ? entry.spans : [];
    return spans.some((span) => !entries.some((other, otherIndex) =>
      otherIndex !== index && Array.isArray(other?.spans) &&
      other.spans.some((cover) =>
        cover.start <= span.start && cover.end >= span.end &&
        (cover.start < span.start || cover.end > span.end)
      )
    ));
  });
}

module.exports = { termSpans, pruneCoveredServiceMentions };
