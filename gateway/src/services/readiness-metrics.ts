/** Only stable, bounded boolean checks are exposed; never labels from providers or exceptions. */
export function readinessMetrics(result: { ok: boolean; checks: Record<string, boolean> }): string {
  const lines = [
    "# HELP anonymo_ready Whether every required dependency and worker is ready.",
    "# TYPE anonymo_ready gauge",
    `anonymo_ready ${result.ok ? 1 : 0}`,
    "# HELP anonymo_readiness_check Individual dependency and worker readiness.",
    "# TYPE anonymo_readiness_check gauge",
  ];
  for (const [check, ready] of Object.entries(result.checks).sort(([a], [b]) => a.localeCompare(b))) {
    // Readiness owns these names; reject unexpected labels rather than leaking content.
    if (/^[a-z][a-z_-]{0,63}$/.test(check)) lines.push(`anonymo_readiness_check{check="${check}"} ${ready ? 1 : 0}`);
  }
  return lines.join("\n") + "\n";
}
