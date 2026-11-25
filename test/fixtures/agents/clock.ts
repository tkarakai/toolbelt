// The fixed "now" of the agent scenario fixtures (test/agent-scenarios): the plugins date their
// content around it and the scenario harness gives the agent core the same clock, so relative
// times ("2d ago", "in 5h") are the same on every run.
export const NOW = Date.UTC(2026, 10, 25, 9, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
