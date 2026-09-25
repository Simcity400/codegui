// @effect-diagnostics globalDate:off globalTimers:off - This callback-based Node HTTP/2 boundary owns JWT expiry and transport deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";
import * as Schema from "effect/Schema";

export const ApplePushConfiguration = Schema.Struct({
  teamId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.String,
  bundleId: Schema.String,
});
export type ApplePushConfiguration = typeof ApplePushConfiguration.Type;

export interface ApplePushMessage {
  readonly token: string;
  readonly environment: "sandbox" | "production";
  readonly kind: "alert" | "background" | "liveactivity";
  /** Apple may defer priority 5 to save power; defaults to 10 except for background pushes. */
  readonly priority?: 5 | 10;
  readonly payload: object;
}

export interface ApplePushResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason: string | null;
}

/** Each request has a bounded HTTP/2 lifetime; no socket survives server shutdown. */
export function createApplePushSender(config: ApplePushConfiguration) {
  const key = NodeCrypto.createPrivateKey(config.privateKey);
  let cachedJwt = "";
  let signedAt = 0;
  return (message: ApplePushMessage): Promise<ApplePushResult> => {
    const now = Math.floor(Date.now() / 1000);
    if (!cachedJwt || now - signedAt >= 1200) {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString(
        "base64url",
      );
      const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString(
        "base64url",
      );
      const input = `${header}.${claims}`;
      cachedJwt = `${input}.${NodeCrypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      signedAt = now;
    }
    return new Promise((resolve, reject) => {
      const session = NodeHttp2.connect(
        message.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com",
      );
      const finish = (error?: Error, result?: ApplePushResult) => {
        clearTimeout(timeout);
        session.destroy();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const timeout = setTimeout(() => finish(new Error("Apple push request timed out.")), 10000);
      session.on("error", (error) => finish(error));
      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${message.token}`,
        authorization: `bearer ${cachedJwt}`,
        "apns-topic":
          config.bundleId + (message.kind === "liveactivity" ? ".push-type.liveactivity" : ""),
        "apns-push-type": message.kind,
        "apns-priority": String(message.priority ?? (message.kind === "background" ? 5 : 10)),
        // Zero tells Apple to drop the push if the phone is briefly unreachable.
        "apns-expiration": String(now + 3600),
      });
      let status = 0;
      let response = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk: string) => {
        response += chunk;
      });
      request.on("error", (error) => finish(error));
      request.on("end", () => {
        let reason: string | null = null;
        try {
          const parsed: unknown = response ? JSON.parse(response) : null;
          if (
            parsed &&
            typeof parsed === "object" &&
            "reason" in parsed &&
            typeof parsed.reason === "string"
          )
            reason = parsed.reason;
        } catch {
          reason = "Invalid Apple push response.";
        }
        finish(undefined, { ok: status === 200, status, reason });
      });
      request.end(JSON.stringify(message.payload));
    });
  };
}
