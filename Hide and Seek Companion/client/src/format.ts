export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function googleMapsUrl([lng, lat]: [number, number]) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// Distinct from the --teal/--orange status colors so a hider's color never reads as a status.
const HIDER_COLORS = ["#4d8cff", "#c15bff", "#ff5bb0", "#ffd75b", "#5be0ff", "#a8ff5b", "#ff9d5b", "#8d8dff"];

// Assigns each hider the next unused color the first time it's seen, so colors stay stable for the
// rest of the session and never collide (unless more hiders appear than the palette has colors).
const hiderColorAssignments = new Map<string, string>();
let nextHiderColorIndex = 0;

export function hiderColor(hiderId: string): string {
  let color = hiderColorAssignments.get(hiderId);
  if (!color) {
    color = HIDER_COLORS[nextHiderColorIndex % HIDER_COLORS.length];
    nextHiderColorIndex += 1;
    hiderColorAssignments.set(hiderId, color);
  }
  return color;
}
