/**
 * Vault.App
 * Wires together crypto, storage, and canvas. Owns the in-memory
 * session key (never persisted) and the debounced autosave.
 */
(() => {
  const VERIFIER_PLAINTEXT = { check: 'vault-ok' };
  const AUTOSAVE_DEBOUNCE_MS = 800;

  let sessionKey = null;   // CryptoKey, held only while unlocked
  let saveTimer = null;

  const lockScreen = document.getElementById('lock-screen');
  const setupForm = document.getElementById('setup-form');
  const unlockForm = document.getElementById('unlock-form');
  const appScreen = document.getElementById('app-screen');
  let canvasRoot = document.getElementById('canvas-root');
  const errorEl = document.getElementById('lock-error');
  const saveIndicator = document.getElementById('save-indicator');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.toggle('visible', !!msg);
  }

  function flashSaved(text) {
    saveIndicator.textContent = text;
    saveIndicator.classList.add('visible');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => saveIndicator.classList.remove('visible'), 1200);
  }

  async function scheduleSave() {
    clearTimeout(saveTimer);
    saveIndicator.textContent = 'Saving…';
    saveIndicator.classList.add('visible');
    saveTimer = setTimeout(async () => {
      try {
        await persistVault();
        flashSaved('Saved');
      } catch (err) {
        console.error('Autosave failed');
        flashSaved('Save failed');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function persistVault() {
    if (!sessionKey) return;
    const record = await VaultStorage.getRecord();
    const vaultPayload = await VaultCrypto.encrypt(sessionKey, VaultCanvas.getState());
    const updated = { ...record, vaultIv: vaultPayload.iv, vaultCiphertext: vaultPayload.ciphertext };
    await VaultStorage.putRecord(updated);
  }

  async function createVault(password) {
    const salt = VaultCrypto.newSalt();
    const key = await VaultCrypto.deriveKey(password, VaultCrypto.fromB64(salt));
    const verifier = await VaultCrypto.encrypt(key, VERIFIER_PLAINTEXT);
    const vaultPayload = await VaultCrypto.encrypt(key, { objects: {}, nextZ: 1 });
    await VaultStorage.putRecord({
      salt,
      iterations: VaultCrypto.PBKDF2_ITERATIONS,
      verifierIv: verifier.iv,
      verifierCiphertext: verifier.ciphertext,
      vaultIv: vaultPayload.iv,
      vaultCiphertext: vaultPayload.ciphertext,
    });
    sessionKey = key;
    enterVault({ objects: {}, nextZ: 1 });
  }

  async function unlockVault(password) {
    const record = await VaultStorage.getRecord();
    if (!record) { showError('No vault found on this device.'); return; }
    const salt = VaultCrypto.fromB64(record.salt);
    const key = await VaultCrypto.deriveKey(password, salt, record.iterations);
    try {
      const verifier = await VaultCrypto.decrypt(key, record.verifierIv, record.verifierCiphertext);
      if (!verifier || verifier.check !== 'vault-ok') throw new Error('bad verifier');
    } catch {
      showError('Incorrect password.');
      return;
    }
    const vaultState = await VaultCrypto.decrypt(key, record.vaultIv, record.vaultCiphertext);
    sessionKey = key;
    enterVault(vaultState);
  }

  function enterVault(initialState) {
    showError('');
    lockScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    VaultCanvas.init(canvasRoot, { onChange: () => scheduleSave() }); // creates the DOM layers render() writes into
    VaultCanvas.loadState(initialState); // then populate + render the restored objects
  }

  function lockVault() {
    sessionKey = null; // discard key from memory — nothing else identifies the plaintext
    VaultCanvas.destroy();
    canvasRoot.replaceWith(canvasRoot.cloneNode(false)); // drop all card DOM/state from the screen
    canvasRoot = document.getElementById('canvas-root');
    appScreen.classList.add('hidden');
    lockScreen.classList.remove('hidden');
    // a vault now definitely exists on disk, so re-locking must always show the unlock form, never "create"
    setupForm.classList.add('hidden');
    unlockForm.classList.remove('hidden');
    document.getElementById('unlock-password').value = '';
    showError('');
  }

  // ---- first-run vs returning ----
  async function boot() {
    const exists = await VaultStorage.vaultExists();
    setupForm.classList.toggle('hidden', exists);
    unlockForm.classList.toggle('hidden', !exists);
  }

  setupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const p1 = document.getElementById('setup-password').value;
    const p2 = document.getElementById('setup-password-confirm').value;
    if (p1.length < 8) return showError('Use at least 8 characters.');
    if (p1 !== p2) return showError('Passwords do not match.');
    showError('');
    await createVault(p1);
  });

  unlockForm.addEventListener('submit', async e => {
    e.preventDefault();
    const p = document.getElementById('unlock-password').value;
    await unlockVault(p);
  });

  document.getElementById('lock-btn').addEventListener('click', lockVault);

  document.getElementById('add-text-btn').addEventListener('click', () => {
    const vp = VaultCanvas.viewport;
    const worldX = (canvasRoot.clientWidth / 2 - vp.x) / vp.scale;
    const worldY = (canvasRoot.clientHeight / 2 - vp.y) / vp.scale;
    VaultCanvas.addObject({ type: 'text', x: worldX - 110, y: worldY - 60, w: 220, h: 120, data: { title: '', body: '' } });
  });

  document.getElementById('add-link-btn').addEventListener('click', () => {
    const url = prompt('Paste a URL:');
    if (!url) return;
    const vp = VaultCanvas.viewport;
    const worldX = (canvasRoot.clientWidth / 2 - vp.x) / vp.scale;
    const worldY = (canvasRoot.clientHeight / 2 - vp.y) / vp.scale;
    VaultCanvas.addObject({ type: 'link', x: worldX - 110, y: worldY - 30, w: 220, h: 60, data: { url } });
  });

  const imageInput = document.getElementById('image-input');
  document.getElementById('add-image-btn').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => VaultCanvas.addImageAtCenter(reader.result);
    reader.readAsDataURL(file);
    imageInput.value = '';
  });

  let drawActive = false;
  const drawBtn = document.getElementById('draw-btn');
  drawBtn.addEventListener('click', () => {
    drawActive = !drawActive;
    drawBtn.classList.toggle('active', drawActive);
    VaultCanvas.setMode(drawActive ? 'draw' : 'select');
    connectBtn.classList.remove('active');
    connectActive = false;
  });

  let connectActive = false;
  const connectBtn = document.getElementById('connect-btn');
  connectBtn.addEventListener('click', () => {
    connectActive = !connectActive;
    connectBtn.classList.toggle('active', connectActive);
    VaultCanvas.setMode(connectActive ? 'connect' : 'select');
    drawBtn.classList.remove('active');
    drawActive = false;
  });

  document.getElementById('undo-btn').addEventListener('click', () => VaultCanvas.undo());
  document.getElementById('redo-btn').addEventListener('click', () => VaultCanvas.redo());
  document.getElementById('zoom-in-btn').addEventListener('click', () => VaultCanvas.zoomAt(canvasRoot.clientWidth / 2, canvasRoot.clientHeight / 2, 1.2));
  document.getElementById('zoom-out-btn').addEventListener('click', () => VaultCanvas.zoomAt(canvasRoot.clientWidth / 2, canvasRoot.clientHeight / 2, 1 / 1.2));
  document.getElementById('zoom-reset-btn').addEventListener('click', () => VaultCanvas.resetView());

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const cards = canvasRoot.querySelectorAll('.vault-card');
    cards.forEach(c => {
      if (!q) { c.classList.remove('dimmed'); return; }
      const text = c.innerText.toLowerCase();
      c.classList.toggle('dimmed', !text.includes(q));
    });
  });

  boot();
})();
