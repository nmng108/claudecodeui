/**
 * A spawnable process that starts but never speaks ACP — used by
 * `kiro-acp.client.test.ts` to exercise the `initialize` timeout path
 * without needing the real agent to hang on command (the main fixture
 * always answers `initialize` immediately).
 */
setInterval(() => {}, 1000);
