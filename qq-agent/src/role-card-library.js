import { NORMAL_ROLE_CARD } from './natural-chat.mjs';
import { ROLE_CARD_PRESETS } from './role-card-presets.js';
import { EXTRA_ROLE_CARD_PRESETS } from './role-card-extra-presets.js';
import { CAT_ROLE_CARD_PRESETS } from './cat-role-cards.js';
import { personaForChat } from './config.js';

export const ORIGINAL_ROLE_CARD_ID = 'local-original';

function personaFields(persona = {}) {
  return {
    roleText: String(persona.roleText ?? ''),
    customRules: String(persona.customRules ?? ''),
    systemPromptOverride: String(persona.systemPromptOverride ?? ''),
    participation: ['low', 'medium', 'high'].includes(persona.participation) ? persona.participation : 'medium'
  };
}

/** Installation adds cards without selecting one or replacing any user card. */
export function installRoleCards(config) {
  const cards = structuredClone(Array.isArray(config.customPersonas) ? config.customPersonas : []);
  if (!cards.some((card) => card.id === ORIGINAL_ROLE_CARD_ID)) {
    const original = personaFields(config.persona);
    cards.push({
      id: ORIGINAL_ROLE_CARD_ID, name: '原始聊天伙伴', aliases: ['原始', '默认', '聊天伙伴'],
      text: original.roleText, ...original,
      source: '安装角色卡切换功能时保存的本机原始人设。', license: '本机自定义人设。'
    });
  }
  for (const preset of [NORMAL_ROLE_CARD, ...CAT_ROLE_CARD_PRESETS, ...ROLE_CARD_PRESETS, ...EXTRA_ROLE_CARD_PRESETS]) {
    if (!cards.some((card) => card.id === preset.id)) cards.push({ ...structuredClone(preset), participation: 'medium', systemPromptOverride: '' });
  }
  return { customPersonas: cards };
}

export function listRoleCards(config) {
  return (Array.isArray(config.customPersonas) ? config.customPersonas : []).flatMap((card, index) => {
    if (!card || typeof card.name !== 'string' || typeof card.text !== 'string' || !card.text.trim()) return [];
    return [{ ...card, id: typeof card.id === 'string' && card.id ? card.id : `custom_${index}` }];
  });
}

export function activeRoleCard(config, chatKey, cards = listRoleCards(config)) {
  const actual = personaFields(personaForChat(chatKey, config));
  const matches = cards.filter((card) => {
    const candidate = personaFields({ ...card, roleText: card.text });
    return Object.keys(actual).every((key) => actual[key].trim?.() === candidate[key].trim?.());
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Build a complete per-chat override; persistence belongs to the caller. */
export function roleCardPatch(config, chatKey, id, { reset = false } = {}) {
  if (!/^(?:group|private):[1-9]\d*$/.test(String(chatKey))) throw new Error('Invalid chat key');
  const targetId = reset ? ORIGINAL_ROLE_CARD_ID : id;
  const matches = listRoleCards(config).filter((card) => card.id === targetId);
  if (matches.length !== 1) throw new Error('Unknown or ambiguous role card');
  const card = matches[0];
  const perChat = structuredClone(config.personaByChat || {});
  const patch = { personaUnified: false };
  // Turning off unified mode must not resurrect dormant overrides in other chats.
  // Keep their previous contents for recovery, while preserving their effective global role.
  if (config.personaUnified !== false && Object.keys(perChat).length) {
    patch.personaCommands = { previousUnifiedOverrides: structuredClone(perChat) };
    for (const key of Object.keys(perChat)) {
      perChat[key] = { ...personaFields(config.persona), roleCardId: 'preserved-global' };
    }
  }
  perChat[chatKey] = { ...personaFields({ ...card, roleText: card.text }), roleCardId: card.id };
  patch.personaByChat = { __replace__: perChat };
  return patch;
}
