/** Små visningshjelpere. Ingen avhengigheter - `Intl` holder. */

/** «for 3 minutter siden», «i går», «aldri». */
export function formatDistanceish(date: Date | null | undefined): string {
  if (!date) return "aldri";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "nå nettopp";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min siden`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} t siden`;
  if (seconds < 172_800) return "i går";
  return `${Math.round(seconds / 86_400)} dager siden`;
}
