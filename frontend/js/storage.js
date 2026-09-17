/**
 * Vault.Storage
 * -------------------------------------------------------------
 * IndexedDB wrapper supporting multiple independent vaults.
 *
 * Two kinds of records live in the one object store:
 *   '__index__'   -> [{ id, name }, ...]   (vault names only — never contents)
 *   'vault:<id>'  -> { salt, iterations, verifierIv, verifierCiphertext,
 *                       dataIv, dataCiphertext }
 *
 * The index only ever holds a user-chosen label and an id — no
 * password, no key, no vault contents. Everything that could
 * reveal what's inside a vault stays behind its own encryption.
 * -------------------------------------------------------------
 */
const VaultStorage = (() => {
  const DB_NAME = 'vault-db';
  const DB_VERSION = 1;
  const STORE = 'vault';
  const INDEX_KEY = '__index__';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getKey(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function putKey(key, value) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function deleteKey(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  async function listVaults() {
    const idx = await getKey(INDEX_KEY);
    return idx || [];
  }

  async function addToIndex(id, name) {
    const idx = await listVaults();
    idx.push({ id, name });
    await putKey(INDEX_KEY, idx);
  }

  async function renameInIndex(id, name) {
    const idx = await listVaults();
    const entry = idx.find(v => v.id === id);
    if (entry) entry.name = name;
    await putKey(INDEX_KEY, idx);
  }

  async function removeFromIndex(id) {
    const idx = await listVaults();
    await putKey(INDEX_KEY, idx.filter(v => v.id !== id));
  }

  function getVaultRecord(id) {
    return getKey('vault:' + id);
  }

  function putVaultRecord(id, record) {
    return putKey('vault:' + id, record);
  }

  async function deleteVault(id) {
    await deleteKey('vault:' + id);
    await removeFromIndex(id);
  }

  function newVaultId() {
    return 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  return {
    listVaults, addToIndex, renameInIndex, removeFromIndex,
    getVaultRecord, putVaultRecord, deleteVault, newVaultId,
  };
})();
