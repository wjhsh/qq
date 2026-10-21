// Suppression affects model context only. The source records remain editable
// and exportable, and group-specific suppression never changes another chat.
export function sharedEntriesForContext(config, chatKey, entries) {
  const match = /^group:([1-9][0-9]*)$/.exec(String(chatKey));
  if (!match) return entries;
  const configured = config.sharedMemory?.suppressedContextEntryIdsByGroup?.[match[1]];
  if (!Array.isArray(configured) || !configured.length) return entries;
  const suppressed = new Set(configured.map(String));
  return entries.filter(entry => !suppressed.has(String(entry.id)));
}
