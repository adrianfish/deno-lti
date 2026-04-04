import type { Storage } from "./storage.ts";
import type { OidcStateData, Platform, StoredAccessToken, StoredContextToken, StoredIdToken } from "../types.ts";

/**
 * DenoKVStorage — zero-dependency storage using Deno's built-in KV store.
 *
 * Key schema:
 *   ["platform", url, clientId]                → Platform
 *   ["platform_by_url", url, clientId]         → true  (index for list-by-url)
 *   ["key_public", kid]                        → encrypted public key string
 *   ["key_private", kid]                       → encrypted private key string
 *   ["idtoken", key]                           → StoredIdToken   (24h TTL)
 *   ["contexttoken", key]                      → StoredContextToken (24h TTL)
 *   ["nonce", nonce]                           → true  (10s TTL)
 *   ["state", state]                           → OidcStateData (10m TTL)
 *   ["accesstoken", platformUrl, clientId, scopes] → StoredAccessToken (1h TTL)
 *
 * Requires: --unstable-kv flag (or "unstable": ["kv"] in deno.json)
 */
export class DenoKVStorage implements Storage {
  #kv: Deno.Kv;

  private constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  static async open(kv?: Deno.Kv, path?: string): Promise<DenoKVStorage> {
    if (kv) return new DenoKVStorage(kv);
    //const newKv = await Deno.openKv(path);
    return new DenoKVStorage(await Deno.openKv(path));
  }

  // -------------------------------------------------------------------------
  // Platforms
  // -------------------------------------------------------------------------

  async savePlatform(
    platform: Platform,
  ): Promise<void> {
    await this.#kv.set(["platform", platform.url, platform.clientId], platform);
  }

  async getPlatform(url: string, clientId: string): Promise<Platform | null> {
    const entry = await this.#kv.get<Platform>(["platform", url, clientId]);
    return entry.value;
  }

  async getPlatformsByUrl(url: string): Promise<Platform[]> {
    const results: Platform[] = [];
    for await (const entry of this.#kv.list<Platform>({ prefix: ["platform", url] })) {
      if (entry.value) results.push(entry.value);
    }
    return results;
  }

  async getAllPlatforms(): Promise<Platform[]> {
    const results: Platform[] = [];
    for await (const entry of this.#kv.list<Platform>({ prefix: ["platform"] })) {
      if (entry.value) results.push(entry.value);
    }
    return results;
  }

  async setPlatformActive(url: string, clientId: string, active: boolean): Promise<void> {
    const platform = await this.getPlatform(url, clientId);
    if (!platform) throw new Error(`Platform not found: ${url} / ${clientId}`);
    await this.#kv.set(["platform", url, clientId], { ...platform, active });
  }

  // -------------------------------------------------------------------------
  // Keypairs
  // -------------------------------------------------------------------------

  async saveKeyPair(
    kid: string,
    encryptedPublicKey: string,
    encryptedPrivateKey: string,
  ): Promise<void> {
    await this.#kv.set(["key_public", kid], encryptedPublicKey);
    await this.#kv.set(["key_private", kid], encryptedPrivateKey);
  }

  async getPublicKey(kid: string): Promise<string | null> {
    const entry = await this.#kv.get<string>(["key_public", kid]);
    return entry.value;
  }

  async getPrivateKey(kid: string): Promise<string | null> {
    const entry = await this.#kv.get<string>(["key_private", kid]);
    return entry.value;
  }

  async getAllPublicKeys(): Promise<Array<{ kid: string; encryptedKey: string }>> {
    const results: Array<{ kid: string; encryptedKey: string }> = [];
    for await (const entry of this.#kv.list<string>({ prefix: ["key_public"] })) {
      if (entry.value) {
        const kid = entry.key[1] as string;
        results.push({ kid, encryptedKey: entry.value });
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // ID tokens
  // -------------------------------------------------------------------------

  async saveIdToken(key: string, token: StoredIdToken, ttlMs: number): Promise<void> {
    await this.#kv.set(["idtoken", key], token, { expireIn: ttlMs });
  }

  async getIdToken(key: string): Promise<StoredIdToken | null> {
    const entry = await this.#kv.get<StoredIdToken>(["idtoken", key]);
    return entry.value;
  }

  // -------------------------------------------------------------------------
  // Context tokens
  // -------------------------------------------------------------------------

  async saveContextToken(
    key: string,
    token: StoredContextToken,
    ttlMs: number,
  ): Promise<void> {
    await this.#kv.set(["contexttoken", key], token, { expireIn: ttlMs });
  }

  async getContextToken(key: string): Promise<StoredContextToken | null> {
    const entry = await this.#kv.get<StoredContextToken>(["contexttoken", key]);
    return entry.value;
  }

  // -------------------------------------------------------------------------
  // Nonces
  // -------------------------------------------------------------------------

  async saveNonce(nonce: string, ttlMs: number): Promise<void> {
    await this.#kv.set(["nonce", nonce], true, { expireIn: ttlMs });
  }

  async hasNonce(nonce: string): Promise<boolean> {
    const entry = await this.#kv.get(["nonce", nonce]);
    return entry.value !== null;
  }

  // -------------------------------------------------------------------------
  // OIDC state
  // -------------------------------------------------------------------------

  async saveState(state: string, data: OidcStateData, ttlMs: number): Promise<void> {
    await this.#kv.set(["state", state], data, { expireIn: ttlMs });
  }

  async getState(state: string): Promise<OidcStateData | null> {
    const entry = await this.#kv.get<OidcStateData>(["state", state]);
    return entry.value;
  }

  async deleteState(state: string): Promise<void> {
    await this.#kv.delete(["state", state]);
  }

  // -------------------------------------------------------------------------
  // Access token cache
  // -------------------------------------------------------------------------

  async saveAccessToken(record: StoredAccessToken, ttlMs: number): Promise<void> {
    await this.#kv.set(
      ["accesstoken", record.platformUrl, record.clientId, record.scopes],
      record,
      { expireIn: ttlMs },
    );
  }

  async getAccessToken(
    platformUrl: string,
    clientId: string,
    scopes: string,
  ): Promise<StoredAccessToken | null> {
    const entry = await this.#kv.get<StoredAccessToken>([
      "accesstoken",
      platformUrl,
      clientId,
      scopes,
    ]);
    if (!entry.value) return null;
    if (entry.value.expiresAt < Date.now()) return null;
    return entry.value;
  }

  close(): void {
    this.#kv.close();
  }
}
