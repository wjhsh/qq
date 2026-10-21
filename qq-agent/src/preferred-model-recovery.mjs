// One bounded, synthetic probe at a time. No chat history or QQ tools are used.
export function createPreferredModelRecovery({ getPlan, probe, switchModel,
  isAvailabilityFailure, now = Date.now, report = () => {} }) {
  let identity = '', successes = 0, nextAt = 0, inflight = null, stopped = false;
  function plan() {
    const p = getPlan();
    if (!p?.enabled || !p.identity || !p.preferredModel || !p.fallbackModel
      || p.preferredModel === p.fallbackModel
      || ![p.preferredModel, p.fallbackModel].includes(p.activeModel)) {
      identity = ''; successes = 0; nextAt = 0;
      return null;
    }
    if (identity !== p.identity) { identity = p.identity; successes = 0; nextAt = 0; }
    return p;
  }
  function same(before, current, active) {
    return current && before.identity === current.identity && current.activeModel === active;
  }
  return {
    async tick() {
      if (stopped || inflight) return;
      const p = plan();
      if (!p || p.activeModel === p.preferredModel || now() < nextAt) return;
      const controller = new AbortController(); inflight = controller;
      nextAt = now() + p.intervalMs;
      try {
        await probe(p, controller.signal);
        if (stopped || controller.signal.aborted || !same(p, plan(), p.fallbackModel)) return;
        successes++;
        report({ event: 'probe_ok', model: p.preferredModel, successes });
        if (successes >= p.successThreshold) {
          switchModel(p, 'preferred');
          successes = 0;
          report({ event: 'restored', model: p.preferredModel });
        }
      } catch (error) {
        if (!stopped && !controller.signal.aborted && same(p, plan(), p.fallbackModel)) {
          successes = 0;
          report({ event: 'probe_failed', model: p.preferredModel,
            reason: isAvailabilityFailure(error) ? 'availability' : 'rejected_or_invalid' });
        }
      } finally { if (inflight === controller) inflight = null; }
    },
    failed(apiKey, error) {
      if (stopped || !isAvailabilityFailure(error)) return false;
      const p = plan();
      if (!p || p.activeModel !== p.preferredModel || apiKey !== p.probeKey) return false;
      switchModel(p, 'fallback');
      successes = 0; nextAt = now() + p.cooldownMs;
      report({ event: 'fallback', model: p.fallbackModel });
      return true;
    },
    stop() { stopped = true; inflight?.abort(); successes = 0; identity = ''; nextAt = 0; },
    resume() { stopped = false; },
    status() { return { successes, nextAt, probing: Boolean(inflight), stopped }; }
  };
}
