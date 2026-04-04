import type { OidcStateData, Platform, StoredAccessToken, StoredContextToken, StoredIdToken } from "../types.ts";

/**
 * Storage — the single interface the rest of the library talks to.
 *
 * Implement this to use any backing store: Deno KV (built-in), PostgreSQL,
 * Redis, SQLite, etc. The default implementation is DenoKVStorage.
 *
 * All TTL values are in **milliseconds**.
 */
export interface Storage {
  // -------------------------------------------------------------------------
  // Platform registry
  // -------------------------------------------------------------------------

  savePlatform(platform: Platform): Promise<void>;

  getPlatform(url: string, clientId: string): Promise<Platform | null>;

  /** Returns all platforms registered under the given issuer URL */
  getPlatformsByUrl(url: string): Promise<Platform[]>;

  getAllPlatforms(): Promise<Platform[]>;

  setPlatformActive(url: string, clientId: string, active: boolean): Promise<void>;

  // -------------------------------------------------------------------------
  // RSA keypairs (stored encrypted — encryption happens in the caller)
  // -------------------------------------------------------------------------

  saveKeyPair(kid: string, encryptedPublicKey: string, encryptedPrivateKey: string): Promise<void>;

  /** Returns the *encrypted* public key PEM */
  getPublicKey(kid: string): Promise<string | null>;

  /** Returns the *encrypted* private key PEM */
  getPrivateKey(kid: string): Promise<string | null>;

  /** Returns all *encrypted* public keys with their kids (for JWKS endpoint) */
  getAllPublicKeys(): Promise<Array<{ kid: string; encryptedKey: string }>>;

  // -------------------------------------------------------------------------
  // ID tokens (24h TTL)
  // -------------------------------------------------------------------------

  saveIdToken(key: string, token: StoredIdToken, ttlMs: number): Promise<void>;

  getIdToken(key: string): Promise<StoredIdToken | null>;

  // -------------------------------------------------------------------------
  // Context tokens (24h TTL)
  // -------------------------------------------------------------------------

  saveContextToken(key: string, token: StoredContextToken, ttlMs: number): Promise<void>;

  getContextToken(key: string): Promise<StoredContextToken | null>;

  // -------------------------------------------------------------------------
  // Nonces — short-lived deduplication keys (10s TTL)
  // -------------------------------------------------------------------------

  saveNonce(nonce: string, ttlMs: number): Promise<void>;

  hasNonce(nonce: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // OIDC state (10-minute TTL)
  // -------------------------------------------------------------------------

  saveState(state: string, data: OidcStateData, ttlMs: number): Promise<void>;

  getState(state: string): Promise<OidcStateData | null>;

  deleteState(state: string): Promise<void>;

  // -------------------------------------------------------------------------
  // OAuth2 access token cache (1h TTL)
  // -------------------------------------------------------------------------

  saveAccessToken(record: StoredAccessToken, ttlMs: number): Promise<void>;

  /** Returns a cached token only if it has not yet expired */
  getAccessToken(
    platformUrl: string,
    clientId: string,
    scopes: string,
  ): Promise<StoredAccessToken | null>;
}
