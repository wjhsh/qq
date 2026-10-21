// Plain text tools must not report media placeholders as delivered images.
export function requirePlainTextMessages(messages) {
  const text = messages.join('\n');
  const face = /\[表情\s*([0-9]{1,6})\]/u.exec(text);
  const sticker = /\[表情包\s*[:：][^\]\r\n]+\]/u.exec(text);
  if (!face && !sticker) return;
  const next = [
    face ? `QQ系统表情请调用 send_face，faceId=${Number(face[1])}。` : '',
    sticker ? '收藏图片请先从 list_stickers 取得真实 stickerId，再调用 send_sticker。' : ''
  ].filter(Boolean).join(' ');
  const error = new Error(`这批文字没有发送：表情占位符不会变成表情。${next} 普通文字请去掉占位符后单独发送；仅解释编号时可写“QQ ${face ? Number(face[1]) : ''}号表情”。`);
  error.code = 'MEDIA_MARKER_REQUIRES_TOOL';
  throw error;
}
