// Privacy-safe analytics for the skill center (PRD §15).
//
// Events carry only coarse, non-identifying fields — NEVER skill names, file
// contents, scripts, or absolute paths. Only the whitelisted keys below are
// forwarded; anything else is dropped. No telemetry backend is wired yet, so
// this logs in dev and is a no-op in production. Swap the sink here when
// telemetry lands.

type SkillEventProps = Record<string, string | number | boolean | undefined>;

const ALLOWED_KEYS = new Set([
  "sourceType",
  "kind",
  "result",
  "errorClass",
  "durationMs",
  "count",
  "failedCount",
  "stage",
]);

export function trackSkillEvent(
  event: string,
  props: SkillEventProps = {},
): void {
  const safe: SkillEventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (ALLOWED_KEYS.has(key) && value !== undefined) {
      safe[key] = value;
    }
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug("[skill-event]", event, safe);
  }
  // TODO: forward `event` + `safe` to telemetry when a sink is available.
}
