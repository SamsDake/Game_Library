import fs from "node:fs";
import crypto from "node:crypto";
import http2 from "node:http2";
import webpush, { type PushSubscription } from "web-push";
import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

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

interface NativeToken {
  token: string;
  platform: "android" | "ios";
}

/**
 * Wraps the `web-push` library: owns the VAPID keypair, the per-player subscription
 * registry, and delivery. Notifications are delivered by the browser's push service
 * even when the PWA is closed/backgrounded (and queued until a powered-off device
 * reconnects). Subscriptions live in memory; clients re-register on every connect.
 */
export class PushService {
  private subs = new Map<string, PushSubscription>();
  private nativeTokens = new Map<string, NativeToken>();
  private publicKey = "";
  private enabled = false;
  private fcm: Messaging | null = null;
  private apns: ApnsSender | null = null;

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
    this.fcm = initFirebase();
    this.apns = initApns();
  }

  get vapidPublicKey() {
    return this.publicKey;
  }

  register(playerId: string | undefined, subscription: PushSubscription | undefined) {
    if (!playerId || !subscription?.endpoint) return;
    this.subs.set(playerId, subscription);
  }

  registerNative(playerId: string | undefined, token: string | undefined, platform: string | undefined) {
    if (!playerId || !token || (platform !== "android" && platform !== "ios")) return;
    this.nativeTokens.set(playerId, { token, platform });
  }

  unregister(playerId: string | undefined) {
    if (playerId) this.subs.delete(playerId);
    if (playerId) this.nativeTokens.delete(playerId);
  }

  clear() {
    this.subs.clear();
    this.nativeTokens.clear();
  }

  sendTo(playerId: string, note: PushNotification) {
    const sub = this.subs.get(playerId);
    if (sub) void this.deliver(playerId, sub, note);
    const native = this.nativeTokens.get(playerId);
    if (native) void this.deliverNative(playerId, native, note);
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

  private async deliverNative(playerId: string, native: NativeToken, note: PushNotification) {
    try {
      if (native.platform === "android") {
        if (!this.fcm) return;
        await this.fcm.send({
          token: native.token,
          notification: { title: note.title, body: note.body },
          data: flattenData(note),
          android: {
            priority: "high",
            notification: { channelId: "game", tag: note.tag }
          }
        });
        return;
      }
      if (!this.apns) return;
      await this.apns.send(native.token, note);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (code === "messaging/registration-token-not-registered" || statusCode === 400 || statusCode === 410) {
        this.nativeTokens.delete(playerId);
      } else {
        console.warn("[push] native send failed", code || statusCode || (err instanceof Error ? err.message : err));
      }
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

function initFirebase(): Messaging | null {
  try {
    if (!getApps().length) {
      const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        || (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
          ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
          : "");
      initializeApp(json
        ? { credential: cert(JSON.parse(json) as ServiceAccount) }
        : { credential: applicationDefault() });
    }
    return getMessaging();
  } catch (err) {
    console.warn("[push] Firebase native push disabled:", err instanceof Error ? err.message : err);
    return null;
  }
}

function initApns(): ApnsSender | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID || "com.urbanhunt.app";
  const rawKey = process.env.APNS_PRIVATE_KEY
    || (process.env.APNS_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.APNS_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : "");
  if (!keyId || !teamId || !rawKey) {
    console.warn("[push] APNs native push disabled: APNS_KEY_ID, APNS_TEAM_ID, and APNS_PRIVATE_KEY are required");
    return null;
  }
  return new ApnsSender({
    keyId,
    teamId,
    bundleId,
    privateKey: rawKey.replace(/\\n/g, "\n"),
    production: String(process.env.APNS_ENV || "").toLowerCase() === "production"
  });
}

function flattenData(note: PushNotification): Record<string, string> {
  const data: Record<string, string> = {};
  if (note.tag) data.tag = note.tag;
  for (const [key, value] of Object.entries(note.data || {})) {
    if (value != null) data[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return data;
}

class ApnsSender {
  private jwt = "";
  private jwtCreatedAt = 0;
  private host: string;

  constructor(private config: {
    keyId: string;
    teamId: string;
    bundleId: string;
    privateKey: string;
    production: boolean;
  }) {
    this.host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  }

  send(deviceToken: string, note: PushNotification) {
    return new Promise<void>((resolve, reject) => {
      const client = http2.connect(`https://${this.host}`);
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10"
      });
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("response", headers => {
        const status = Number(headers[":status"] || 0);
        req.on("end", () => {
          client.close();
          if (status >= 200 && status < 300) resolve();
          else {
            const err = new Error(body || `APNs returned ${status}`) as Error & { statusCode?: number };
            err.statusCode = status;
            reject(err);
          }
        });
      });
      req.on("error", err => {
        client.close();
        reject(err);
      });
      req.end(JSON.stringify({
        aps: {
          alert: { title: note.title, body: note.body },
          sound: "default",
          "thread-id": note.tag
        },
        data: note.data || {}
      }));
    });
  }

  private token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwtCreatedAt < 50 * 60) return this.jwt;
    const header = base64Url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const payload = base64Url(JSON.stringify({ iss: this.config.teamId, iat: now }));
    const input = `${header}.${payload}`;
    const signature = crypto.sign("sha256", Buffer.from(input), {
      key: this.config.privateKey,
      dsaEncoding: "ieee-p1363"
    });
    this.jwt = `${input}.${base64Url(signature)}`;
    this.jwtCreatedAt = now;
    return this.jwt;
  }
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
