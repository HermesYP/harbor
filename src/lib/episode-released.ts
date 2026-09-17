// Bulk watched actions require a known release date, not an undated placeholder.
export function isEpisodeReleased(date: string | null | undefined): boolean {
  if (!date) return false;
  // Providers' date-only values follow the episode list's local calendar day.
  // Preserve explicit times and offsets when the provider supplies them.
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date);
  return Number.isFinite(at) && at <= Date.now();
}
