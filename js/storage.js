/**
 * Vault.Storage
 * -------------------------------------------------------------
 * Thin IndexedDB wrapper. Stores exactly one record: the
 * account meta (salt, iterations, encrypted verifier) and the
 * encrypted vault blob (IV + ciphertext). Nothing here ever
 * sees plaintext canvas content or the password.
 * -------------------------------------------------------------
 */
const VaultStorage = (() => {
  const DB_NAME = 'vault-db';
  const DB_VERSION = 1;
  const STORE = 'vault';
  const RECORD_KEY = 'singleton';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getRecord() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putRecord(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function vaultExists() {
    const rec = await getRecord();
    return !!rec;
  }

  async function eraseEverything() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { getRecord, putRecord, vaultExists, eraseEverything };
})();
