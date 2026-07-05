const rawBase = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

export const API_BASE_URL = rawBase;

export function apiUrl(path: string) {
  if (!API_BASE_URL) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function assetUrl(path: string) {
  if (!path || /^https?:\/\//i.test(path)) return path;
  return apiUrl(path);
}

export function socketServerUrl() {
  if (!API_BASE_URL || typeof window === "undefined") return undefined;
  return new URL(API_BASE_URL, window.location.origin).origin;
}

export function socketIoPath() {
  if (!API_BASE_URL || typeof window === "undefined") return "/socket.io";
  const pathname = new URL(API_BASE_URL, window.location.origin).pathname.replace(/\/+$/, "");
  return `${pathname || ""}/socket.io`;
}
