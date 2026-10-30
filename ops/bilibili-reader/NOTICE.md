# Upstream attribution

`video-repair-contract.json` contains short function excerpts from the server's existing `@xzxzzx/bilibili-mcp` 1.14.3 copy, whose package declares Apache-2.0. The upstream license is preserved in `UPSTREAM-LICENSE`.

`upstream-video-repair.json` records the exact before/after edits and hashes. Changes add authenticated metadata requests, correct WBI timestamp/key length/encoding, and remove header values from debug diagnostics. The server copy had earlier modifications; this is not a claim that its hashes represent pristine npm source.

The WBI contract was independently checked against the published `bilibili-api-python` 17.4.2 wheel, with the archive hash recorded in the repair plan. No production credentials are part of these fixtures or files.
