import type { Socket } from "socket.io-client";
import { apiUrl } from "./api";

// Registers the service worker, asks for notification permission, subscribes to
// Web Push, and hands the subscription to the server. Safe to call repeatedly
// (e.g. on every (re)connect) — it reuses an existing subscription.
export async function setupPush(socket: Socket, playerId: string, playerSecret: string): Promise<void> {
  if (typeof window === "undefined" || !playerId) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  try {
    const swUrl = new URL("sw.js", new URL(import.meta.env.BASE_URL, window.location.origin));
    const registration = await navigator.serviceWorker.register(swUrl, { scope: import.meta.env.BASE_URL });

    if (Notification.permission === "denied") return;
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") return;

    const res = await fetch(apiUrl("/api/push/vapid"));
    const { publicKey } = (await res.json()) as { publicKey?: string };
    if (!publicKey) return;

    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
    });

    socket.emit("register_push", { playerId, playerSecret, subscription: subscription.toJSON() });
  } catch (err) {
    console.warn("[push] setup failed", err);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
