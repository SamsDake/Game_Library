export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function googleMapsUrl([lng, lat]: [number, number]) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
