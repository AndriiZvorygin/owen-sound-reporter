const tokens = (value) => String(value || '').toLowerCase().match(/[a-z0-9]+/gu) || [];
const proseKey = (value) => tokens(value).join(' ');

export function resemblesOpeningFragment(summary = '', source = '') {
  const summaryTokens = tokens(summary).slice(0, 18);
  const sourceTokens = tokens(source).slice(0, 80);
  if (summaryTokens.length < 10 || sourceTokens.length < 10) return false;
  return sourceTokens.join(' ').includes(summaryTokens.slice(0, Math.min(14, summaryTokens.length)).join(' '));
}

export function assertAgendaPublishable(items = []) {
  for (const item of items) {
    const summary = String(item.agenda_section_summary || '').trim();
    const chapters = Array.isArray(item.stage3_chapters) ? item.stage3_chapters : [];
    const attachmentBacked = Array.isArray(item.attachments) && item.attachments.length > 0;
    if (attachmentBacked && item.substantive && !summary) throw new Error(`publish gate: substantive attachment-backed agenda item ${item.item} has no Stage 3 summary`);
    if (item.substantive && !summary) throw new Error(`publish gate: substantive agenda item ${item.item} has no Stage 3 summary`);
    if (item.substantive && resemblesOpeningFragment(summary, item.source_text)) throw new Error(`publish gate: Stage 3 summary for agenda item ${item.item} resembles an opening-fragment fallback`);
    if (item.long_source && item.substantive && !item.procedural && chapters.length === 0) throw new Error(`publish gate: long agenda item ${item.item} has no Stage 3 child summaries`);
    const seenTitles = new Set();
    const seenSummaries = new Set();
    for (const [index, chapter] of chapters.entries()) {
      const title = String(chapter?.title || '').trim();
      const text = String(chapter?.summary || chapter?.text || '').trim();
      if (!title || !text) throw new Error(`publish gate: agenda item ${item.item} has an empty child summary at index ${index + 1}`);
      const titleKey = proseKey(title);
      const summaryKey = proseKey(text);
      if (seenTitles.has(titleKey) || seenSummaries.has(summaryKey)) {
        throw new Error(`publish gate: agenda item ${item.item} has duplicate child summaries`);
      }
      seenTitles.add(titleKey);
      seenSummaries.add(summaryKey);
    }
  }
}
