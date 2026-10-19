import { createBashToolDefinition } from '/opt/codex-qq/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js';

export function boundedBashTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 120) : 60;
}

// Explicit, root-owned extension only; automatic extension discovery stays off.
export default function taskGuard(pi) {
  const base = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...base,
    description: base.description + ' Commands default to 60 seconds and cannot exceed 120 seconds. Stop and explain when the requested runtime settings are not in the source workspace.',
    async execute(id, args, signal, onUpdate, ctx) {
      return base.execute(id, { ...args, timeout: boundedBashTimeout(args?.timeout) }, signal, onUpdate, ctx);
    }
  });
}
