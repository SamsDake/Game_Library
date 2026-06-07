import { Capacitor } from "@capacitor/core";
import { PushNotifications, type Token } from "@capacitor/push-notifications";
import type { Socket } from "socket.io-client";
import { apiUrl } from "./api";

let nativeToken: string | null = null;
let nativeListenersReady = false;
let nativeRegistering = false;
let nativeIdentity: { socket: Socket; playerId: string; playerSecret: string } | null = null;
const nativePushEnabled = import.meta.env.VITE_NATIVE_PUSH_ENABLED === "true";

// Registers native push when running inside Capacitor, otherwise uses Web Push
// for browser/PWA installs. Safe to call repeatedly on reconnect.
export async function setupPush(socket: Socket, playerId: string, playerSecret: string): Promise<void> {
  if (typeof window === "undefined" || !playerId) return;
  if (Capacitor.isNativePlatform()) {
    if (!nativePushEnabled) return;
    await setupNativePush(socket, playerId, playerSecret);
    return;
  }
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

async function setupNativePush(socket: Socket, playerId: string, playerSecret: string): Promise<void> {
  nativeIdentity = { socket, playerId, playerSecret };
  await ensureNativeListeners();
  if (nativeToken) emitNativeToken(nativeToken);
  try {
    if (Capacitor.getPlatform() === "android") {
      await PushNotifications.createChannel({
        id: "game",
        name: "Game alerts",
        importance: 5,
        visibility: 1,
        lights: true,
        vibration: true
      });
    }
    let permissions = await PushNotifications.checkPermissions();
    if (permissions.receive === "prompt") permissions = await PushNotifications.requestPermissions();
    if (permissions.receive !== "granted") return;
    if (!nativeRegistering) {
      nativeRegistering = true;
      await PushNotifications.register();
    }
  } catch (err) {
    nativeRegistering = false;
    console.warn("[push] native setup failed", err);
  }
}

async function ensureNativeListeners(): Promise<void> {
  if (nativeListenersReady) return;
  nativeListenersReady = true;
  await PushNotifications.addListener("registration", (token: Token) => {
    nativeToken = token.value;
    emitNativeToken(token.value);
  });
  await PushNotifications.addListener("registrationError", err => {
    nativeRegistering = false;
    console.warn("[push] native registration failed", err.error);
  });
}

function emitNativeToken(token: string): void {
  if (!nativeIdentity) return;
  nativeIdentity.socket.emit("register_push", {
    playerId: nativeIdentity.playerId,
    playerSecret: nativeIdentity.playerSecret,
    nativeToken: token,
    platform: Capacitor.getPlatform()
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
