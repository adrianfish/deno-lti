/**
 * AES-256-CBC encryption helpers using the Web Crypto API.
 *
 * All operations are async; the key is derived once in LTIHandler.setup()
 * and reused throughout the lifecycle.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * Derive a 256-bit AES-CBC CryptoKey from an arbitrary string passphrase
 * by SHA-256 hashing it.
 */
export async function deriveAesKey(passphrase: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", ENC.encode(passphrase));
  return crypto.subtle.importKey("raw", hash, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a UTF-8 string. Returns `<iv_hex>:<ciphertext_hex>`. */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    ENC.encode(plaintext),
  );
  return `${buf2hex(iv)}:${buf2hex(new Uint8Array(cipherBuf))}`;
}

/** Decrypt a value produced by `encrypt`. */
export async function decrypt(ciphertext: string, key: CryptoKey): Promise<string> {
  const [ivHex, datHex] = ciphertext.split(":");
  const iv = hex2buf(ivHex);
  const data = hex2buf(datHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data);
  return DEC.decode(plain);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buf2hex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hex2buf(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
