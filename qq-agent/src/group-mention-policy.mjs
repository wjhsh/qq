// A strict per-group gate. Only a top-level OneBot @ segment addressed to the
// actual bot account authorizes a response; text/quotes/@all do not qualify.
export function groupMentionPolicy(config, kind, id, segments, selfId) {
  const onlyMentions = kind === 'group' && Array.isArray(config?.harnessControl?.mentionOnlyGroups)
    && config.harnessControl.mentionOnlyGroups.map(String).includes(String(id));
  const isBotAt = (segment) => segment?.type === 'at' && /^[1-9][0-9]*$/u.test(String(selfId ?? ''))
    && String(segment.data?.qq ?? '') === String(selfId);
  const mentioned = Array.isArray(segments) && segments.some(isBotAt);
  return {
    onlyMentions,
    mayRespond: !onlyMentions || mentioned,
    // Deterministic slash handlers require text-only input. Remove just the
    // verified bot mention, leaving replies, forwards and other @s untouched.
    commandSegments: mentioned ? segments.filter((segment) => !isBotAt(segment)) : segments
  };
}
