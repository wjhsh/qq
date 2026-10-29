// Local account policy. Text, nicknames and model guesses never identify a bot.
import { modelInputAllowed } from './input-guard.mjs';
const validId = value => /^[1-9][0-9]{4,14}$/.test(String(value ?? ''));

export function automatedPeers(config, chatKey) {
  const policy = config?.botInteraction;
  if (policy?.enabled !== true) return new Set();
  const group = /^group:([1-9][0-9]*)$/.exec(String(chatKey));
  const local = group ? policy.byGroup?.[group[1]] : [];
  return new Set([...(Array.isArray(policy.userIds) ? policy.userIds : []),
    ...(Array.isArray(local) ? local : [])].map(String).filter(validId));
}

export function isAutomatedPeer(config, chatKey, userId) {
  return automatedPeers(config, chatKey).has(String(userId ?? ''));
}

export function incomingPeerPolicy(config, chatKey, event, selfId = '') {
  if (config?.botInteraction?.enabled !== true) return { ignore: false, directedElsewhere: false };
  const sender = event?.sender || {};
  const senderId = String(sender.user_id ?? event?.user_id ?? '');
  const transportBot = sender.is_bot === true || sender.is_robot === true
    || event?.is_bot === true || event?.is_robot === true;
  const knownPeer = transportBot || isAutomatedPeer(config, chatKey, senderId);
  const at = (Array.isArray(event?.message) ? event.message : [])
    .filter(segment => segment?.type === 'at').map(segment => String(segment.data?.qq ?? ''));
  const calledUs = Boolean(selfId) && at.includes(String(selfId));
  const limitedPeer = config?.socialBehavior?.enabled === true && config.socialBehavior.allowDirectPeers === true
    && String(chatKey).startsWith('group:') && calledUs;
  const ignore = knownPeer && !limitedPeer;
  const directedElsewhere = !calledUs && at.some(id => isAutomatedPeer(config, chatKey, id));
  return { ignore, directedElsewhere, knownPeer };
}

export function mayTriggerPeerReply(config, chatKey, entry) {
  const limitedPeer = config?.socialBehavior?.enabled === true && config.socialBehavior.allowDirectPeers === true
    && String(chatKey).startsWith('group:') && entry?.atMe === true;
  return !entry || (modelInputAllowed(entry) && (entry.self === true || (!isAutomatedPeer(config, chatKey, entry.senderId)
    && entry.automatedPeer !== true && !(entry.peerDirected === true && entry.atMe !== true)) || limitedPeer));
}

export function filterAutomatedHistory(config, chatKey, messages) {
  return messages.filter(message => modelInputAllowed(message) && (message.self === true
    || (!isAutomatedPeer(config, chatKey, message.senderId) && message.automatedPeer !== true)));
}

export function assertPeerTargets(config, chatKey, { atUserId, replyToMessageId,
  peerPokeTarget, peerSegments = [], store } = {}) {
  if (config?.botInteraction?.enabled !== true) return;
  const ids = [atUserId, peerPokeTarget];
  const replies = [replyToMessageId];
  for (const segment of peerSegments) {
    if (segment?.type === 'at') ids.push(segment.data?.qq);
    if (segment?.type === 'reply') replies.push(segment.data?.id);
    if (segment?.type === 'poke') ids.push(segment.data?.qq ?? segment.data?.id);
  }
  const privateChat = /^private:([1-9][0-9]*)$/.exec(String(chatKey));
  if (privateChat) ids.push(privateChat[1]);
  const replyPeer = replies.some(mid => {
    if(mid==null)return false;
    const entry=store?.findByMid?.(chatKey,mid);
    return entry?.automatedPeer===true||isAutomatedPeer(config,chatKey,entry?.senderId);
  });
  if (replyPeer || ids.some(id => isAutomatedPeer(config, chatKey, id))) {
    const error = new Error('已设置不与机器人互聊：不要回复、@或拍已标记的机器人；可以回应真人的问题。');
    error.name = 'AutomatedPeerError';
    throw error;
  }
}
