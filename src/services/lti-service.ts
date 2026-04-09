import { Storage } from "../storage/storage.ts";
import { generateAndStorePlatformKeyPair } from "../auth/keys.ts";

import type { Platform, ToolOptions } from "../types.ts";

export class LTIService {
  #aesKey!: CryptoKey;
  toolDomain!: string;
  #options!: ToolOptions;
  #storage!: Storage;

  constructor(options: ToolOptions = {}) {
    this.#options = options;
  }

  set aesKey(aesKey: CryptoKey) { this.#aesKey = aesKey; }
  //set toolDomain(toolDomain: string) { this.toolDomain = toolDomain; }
  set storage(storage: Storage) { this.#storage = storage; }

  async registerPlatform(platform: Platform): Promise<Platform> {
    const existing = await this.#storage.getPlatform(platform.url, platform.clientId);
    if (existing) {
      if (this.#options.debug) console.debug(`Existing platform for url ${platform.url} and clientId ${platform.clientId}`);
      return existing;
    }

    const kid = this.buildKeyId(platform);
    if (this.#options.debug) console.debug(`KID: ${kid}`);
    await generateAndStorePlatformKeyPair(kid, this.#storage, this.#aesKey);

    await this.#storage.savePlatform(platform);
    return platform;
  }

  async getPlatform(url: string, clientId?: string): Promise<Platform | null> {
    if (clientId) return await this.#storage.getPlatform(url, clientId);
    const platforms: Platform[] = await this.#storage.getPlatformsByUrl(url);
    if (platforms.length) return platforms[0];

    console.warn(`No platform found for url ${url} and clientId ${clientId}`);
    return null;
  }

  async getPlatforms(url: string): Promise<Platform[] | null> {
    return await this.#storage.getPlatformsByUrl(url);
  }

  /**
   * Delete a platform. The platform will be marked as inactive but the data will be
   * left in the storage.
   *
   * @param {string} url The url, or iss, of the plaform to be deleted.
   * @param {string} clientId The clientId of the platform to be deleted.
   *
   * @return {Promise} A promise which will be fulfilled when the deletion has completed
   */
  async deletePlatform(url: string, clientId: string): Promise<void> {
    await this.#storage.setPlatformActive(url, clientId, false);
  }

  buildKeyId = (platform: Platform): string => `${platform.url}\$\$${platform.clientId}`;
}
