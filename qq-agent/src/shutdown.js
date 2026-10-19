// systemd uses SIGTERM, while interactive consoles use SIGINT. Stop once for either.
export function installShutdown(app, { signals = process, exit = code => process.exit(code), timeoutMs = 20000, log = console } = {}) {
  let stopping = false, finished = false, timer = null;
  const finish = code => {
    if (finished) return;
    finished = true; clearTimeout(timer); exit(code);
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    timer = setTimeout(() => { log.error('退出清理超时'); finish(1); }, timeoutMs);
    timer.unref?.();
    try { await app.stop(); finish(0); }
    catch (error) { log.error('退出清理失败', error?.message ?? error); finish(1); }
  };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  return () => { signals.off('SIGINT', stop); signals.off('SIGTERM', stop); clearTimeout(timer); };
}
