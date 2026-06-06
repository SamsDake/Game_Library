import fs from "node:fs";
import webpush, { type PushSubscription } from "web-push";

export interface PushNotification {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Wraps the `web-push` library: owns the VAPID keypair, the per-player subscription
 * registry, and delivery. Notifications are delivered by the browser's push service
 * even when the PWA is closed/backgrounded (and queued until a powered-off device
 * reconnects). Subscriptions live in memory; clients re-register on every connect.
 */
export class PushService {
  private subs = new Map<string, PushSubscription>();
  private publicKey = "";
  private enabled = false;

  constructor(private keyFile: string) {}

  init() {
    const subject = process.env.VAPID_SUBJECT || "mailto:admin@urban-hunt.local";
    let keys: VapidKeys | null = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : this.readKeyFile();
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      this.writeKeyFile(keys);
      console.warn(`[push] generated VAPID keypair -> ${this.keyFile}`);
    }
    try {
      webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
      this.publicKey = keys.publicKey;
      this.enabled = true;
    } catch (err) {
      console.warn("[push] disabled:", err instanceof Error ? err.message : err);
    }
  }

  get vapidPublicKey() {
    return this.publicKey;
  }

  register(playerId: string | undefined, subscription: PushSubscription | undefined) {
    if (!playerId || !subscription?.endpoint) return;
    this.subs.set(playerId, subscription);
  }

  unregister(playerId: string | undefined) {
    if (playerId) this.subs.delete(playerId);
  }

  clear() {
    this.subs.clear();
  }

  sendTo(playerId: string, note: PushNotification) {
    const sub = this.subs.get(playerId);
    if (sub) void this.deliver(playerId, sub, note);
  }

  sendToMany(playerIds: Iterable<string>, note: PushNotification) {
    for (const playerId of playerIds) this.sendTo(playerId, note);
  }

  private async deliver(playerId: string, sub: PushSubscription, note: PushNotification) {
    if (!this.enabled) return;
    try {
      await webpush.sendNotification(sub, JSON.stringify(note));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) this.subs.delete(playerId);
      else console.warn("[push] send failed", statusCode || (err instanceof Error ? err.message : err));
    }
  }

  private readKeyFile(): VapidKeys | null {
    try {
      if (!fs.existsSync(this.keyFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.keyFile, "utf8")) as VapidKeys;
      return parsed.publicKey && parsed.privateKey ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeKeyFile(keys: VapidKeys) {
    try {
      fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2));
    } catch (err) {
      console.warn("[push] could not persist VAPID keys", err instanceof Error ? err.message : err);
    }
  }
}
