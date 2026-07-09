import type { OidcStateData, Platform, StoredAccessToken, StoredContextToken, StoredIdToken } from "../types.ts";

/** A page of members plus the counts DataTables needs to render pagination. */
export interface MemberPage {
  members: Array<object>;
  /** Total member records, ignoring any filter. */
  recordsTotal: number;
  /** Member records matching the active filter. */
  recordsFiltered: number;
}

/** Cached per-group membership counts, plus the overall member total. */
export interface GroupTotals {
  /** Total number of member records in the context. */
  total: number;
  /** Member count keyed by group id. */
  byGroup: Record<string, number>;
}

export interface Storage {

  savePlatform(platform: Platform): Promise<void>;

  getPlatform(url: string, clientId: string): Promise<Platform | null>;

  getPlatformsByUrl(url: string): Promise<Array<Platform>>;

  getAllPlatforms(): Promise<Array<Platform>>;

  setPlatformActive(url: string, clientId: string, active: boolean): Promise<void>;

  saveKeyPair(
    kid: string,
    encryptedPublicKey: string,
    encryptedPrivateKey: string,
  ): Promise<void>;

  getPublicKey(kid: string): Promise<string | null>;

  getPrivateKey(kid: string): Promise<string | null>;

  getAllPublicKeys(): Promise<Array<{ kid: string; encryptedKey: string }>>;

  saveIdToken(key: string, token: StoredIdToken, ttlMs: number): Promise<void>;

  getIdToken(key: string): Promise<StoredIdToken | null>;

  saveContextToken(
    key: string,
    token: StoredContextToken,
    ttlMs: number,
  ): Promise<void>;

  getContextToken(key: string): Promise<StoredContextToken | null>;

  // -------------------------------------------------------------------------
  // Nonces
  // -------------------------------------------------------------------------

  saveNonce(nonce: string, ttlMs: number): Promise<void>;

  hasNonce(nonce: string): Promise<boolean>;

  saveState(state: string, data: OidcStateData, ttlMs: number): Promise<void>;

  getState(state: string): Promise<OidcStateData | null>;

  deleteState(state: string): Promise<void>;

  saveAccessToken(record: StoredAccessToken, ttlMs: number): Promise<void>;

  getAccessToken(
    platformUrl: string,
    clientId: string,
    requestedScopes: string,
  ): Promise<StoredAccessToken | null>;

  isMembersCaching(clientId: string, contextId: string): Promise<boolean>;

  setMembersCaching(clientId: string, contextId: string): Promise<boolean>;

  unsetMembersCaching(clientId: string, contextId: string): Promise<void>;

  setMember(clientId: string, contextId: string, user: any): Promise<boolean>;

  hasAnyMembers(clientId: string, contextId: string): Promise<boolean>;

  getPageOfMembers(
    clientId: string,
    contextId: string,
    start: number,
    length: number,
    filter?: (object) => boolean,
    filteredCount?: number,
  ): Promise<MemberPage>;

  getAllMembers(clientId: string, contextId: string): Promise<Array<object>>;

  getCachedTotals(clientId: string, contextId: string): Promise<Record<string, number> | null>;

  getCachedGroupTotals(clientId: string, contextId: string): Promise<GroupTotals | null>;

  cacheTotals(clientId: string, contextId: string): Promise<Record<string, number>>;

  hasAnyGroups(clientId: string, contextId: string): Promise<boolean>;

  isGroupsCaching(clientId: string, contextId: string): Promise<boolean>;

  setGroupsCaching(clientId: string, contextId: string): Promise<boolean>;

  unsetGroupsCaching(clientId: string, contextId: string): Promise<void>;

  setGroup(clientId: string, contextId: string, group: object): Promise<boolean>;

  getGroups(clientId: string, contextId: string): Promise<Array<object>>;
}
