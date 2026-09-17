/**
 * Vault.Crypto
 * -------------------------------------------------------------
 * All cryptography here is delegated to the browser's native
 * Web Crypto API (SubtleCrypto). Nothing here is hand-rolled.
 *
 *   password  --PBKDF2-HMAC-SHA256(600,000 iters)-->  256-bit key
 *   key + plaintext  --AES-256-GCM(random 96-bit IV)-->  ciphertext
 *
 * The derived key never touches disk. It lives only as a
 * non-extractable CryptoKey held in memory for the unlocked
 * session and is discarded on lock/close.
 * -------------------------------------------------------------
 */
const VaultCrypto = (() => {
  const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 floor for PBKDF2-SHA256
  const KEY_LENGTH_BITS = 256;

  function randomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    // non-extractable: the raw key material can never be pulled back out of
    // the CryptoKey object, even by this same code.
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: KEY_LENGTH_BITS },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(key, plaintextObj) {
    const iv = randomBytes(12);
    const enc = new TextEncoder();
    const data = enc.encode(JSON.stringify(plaintextObj));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv: toB64(iv), ciphertext: toB64(ciphertext) };
  }

  async function decrypt(key, ivB64, ciphertextB64) {
    const iv = fromB64(ivB64);
    const ciphertext = fromB64(ciphertextB64);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plainBuf));
  }

  function newSalt() {
    return toB64(randomBytes(16));
  }

  return {
    PBKDF2_ITERATIONS,
    deriveKey,
    encrypt,
    decrypt,
    newSalt,
    fromB64,
    toB64,
  };
})();
