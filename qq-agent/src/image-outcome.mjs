// Stop the model after a failed image call. The host delivers the factual
// notice through the same scoped sender, so RP cannot invent a success.
export async function finishFailedImageTool({ toolName, result, ctx }) {
  if (toolName !== 'local-image__generate_image' || result?.isError !== true) {
    return { handled: false };
  }
  if (ctx.signal?.aborted) return { handled: true, noticeSent: false };
  const notice = typeof result.content === 'string' && result.content.trim()
    ? result.content.trim().slice(0, 1000)
    : '图片处理失败，本次未确认成功发图，请稍后重新发出要求。';
  try {
    const sent = await ctx.sender.sendTextBatch(ctx.chatKey, [notice]);
    const delivered = (sent?.sent ?? []).filter((item) => item.deduped !== true
      && /^-?[1-9][0-9]*$/u.test(String(item.messageId ?? '')));
    if (Array.isArray(ctx.session?.sent)) {
      ctx.session.sent.push(...delivered.map((item) => ({ type: 'text', text: item.text, at: item.at })));
    }
    return { handled: true, noticeSent: delivered.length > 0 };
  } catch {
    // Silence, permission changes, aborts and uncertain sends never fall back
    // to the model or bypass the sender's existing checks.
    return { handled: true, noticeSent: false };
  }
}
