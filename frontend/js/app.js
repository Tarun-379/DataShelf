/**
 * Vault.App
 * Wires crypto, storage, and canvas together. Owns the in-memory
 * session key, the active vault's decrypted data, auto-lock, and
 * the debounced autosave.
 */
(() => {
  const VERIFIER_PLAINTEXT = { check: 'vault-ok' };
  const AUTOSAVE_DEBOUNCE_MS = 800;
  const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes idle

  let sessionKey = null;      // CryptoKey, held only while unlocked
  let currentVaultId = null;
  let currentVaultName = '';
  let vaultData = null;       // { canvases: { id: {objects,nextZ} }, activeCanvasId, nextCanvasN }
  let saveTimer = null;
  let lastActivity = Date.now();
  let autoLockTimer = null;

  // ---- DOM refs ----
  const pickerScreen = document.getElementById('picker-screen');
  const vaultList = document.getElementById('vault-list');
  const newVaultBtn = document.getElementById('new-vault-btn');

  const lockScreen = document.getElementById('lock-screen');
  const setupForm = document.getElementById('setup-form');
  const unlockForm = document.getElementById('unlock-form');
  const unlockingName = document.getElementById('unlocking-vault-name');
  const backToPickerBtn = document.getElementById('back-to-picker-btn');
  const errorEl = document.getElementById('lock-error');

  const appScreen = document.getElementById('app-screen');
  let canvasRoot = document.getElementById('canvas-root');
  const minimapEl = document.getElementById('minimap');
  const saveIndicator = document.getElementById('save-indicator');

  const canvasTabsEl = document.getElementById('canvas-tabs');
  const pinPanel = document.getElementById('pin-panel');
  const suggestPanel = document.getElementById('suggest-panel');

  let unlockTargetVaultId = null;
  let unlockTargetVaultName = '';

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

  // ---------------- vault picker ----------------
  async function renderVaultPicker() {
    const vaults = await VaultStorage.listVaults();
    vaultList.innerHTML = '';
    if (!vaults.length) {
      vaultList.innerHTML = '<div class="empty-hint">No vaults yet. Create your first one.</div>';
    }
    for (const v of vaults) {
      const row = document.createElement('button');
      row.className = 'vault-row';
      row.textContent = v.name;
      row.addEventListener('click', () => goToUnlock(v.id, v.name));
      vaultList.appendChild(row);
    }
  }

  function goToUnlock(id, name) {
    unlockTargetVaultId = id;
    unlockTargetVaultName = name;
    unlockingName.textContent = name;
    pickerScreen.classList.add('hidden');
    lockScreen.classList.remove('hidden');
    document.getElementById('setup-sub').classList.add('hidden');
    document.getElementById('unlock-sub').classList.remove('hidden');
    setupForm.classList.add('hidden');
    unlockForm.classList.remove('hidden');
    showError('');
  }

  function goToCreate() {
    unlockTargetVaultId = null;
    pickerScreen.classList.add('hidden');
    lockScreen.classList.remove('hidden');
    document.getElementById('unlock-sub').classList.add('hidden');
    document.getElementById('setup-sub').classList.remove('hidden');
    unlockForm.classList.add('hidden');
    setupForm.classList.remove('hidden');
    showError('');
  }

  backToPickerBtn.addEventListener('click', () => {
    lockScreen.classList.add('hidden');
    pickerScreen.classList.remove('hidden');
    renderVaultPicker();
  });
  newVaultBtn.addEventListener('click', goToCreate);

  // ---------------- create / unlock ----------------
  async function createVault(name, password) {
    const id = VaultStorage.newVaultId();
    const salt = VaultCrypto.newSalt();
    const key = await VaultCrypto.deriveKey(password, VaultCrypto.fromB64(salt));
    const verifier = await VaultCrypto.encrypt(key, VERIFIER_PLAINTEXT);
    const initialData = { canvases: { c1: { objects: {}, nextZ: 1 } }, activeCanvasId: 'c1', nextCanvasN: 2 };
    const dataPayload = await VaultCrypto.encrypt(key, initialData);
    await VaultStorage.putVaultRecord(id, {
      salt, iterations: VaultCrypto.PBKDF2_ITERATIONS,
      verifierIv: verifier.iv, verifierCiphertext: verifier.ciphertext,
      dataIv: dataPayload.iv, dataCiphertext: dataPayload.ciphertext,
    });
    await VaultStorage.addToIndex(id, name);
    sessionKey = key;
    currentVaultId = id;
    currentVaultName = name;
    enterVault(initialData);
  }

  async function unlockVault(id, name, password) {
    const record = await VaultStorage.getVaultRecord(id);
    if (!record) { showError('Vault record not found.'); return; }
    const salt = VaultCrypto.fromB64(record.salt);
    const key = await VaultCrypto.deriveKey(password, salt, record.iterations);
    try {
      const verifier = await VaultCrypto.decrypt(key, record.verifierIv, record.verifierCiphertext);
      if (!verifier || verifier.check !== 'vault-ok') throw new Error('bad verifier');
    } catch {
      showError('Incorrect password.');
      return;
    }
    const data = await VaultCrypto.decrypt(key, record.dataIv, record.dataCiphertext);
    sessionKey = key;
    currentVaultId = id;
    currentVaultName = name;
    enterVault(data);
  }

  function enterVault(data) {
    showError('');
    vaultData = data;
    if (!vaultData.canvases) vaultData = { canvases: { c1: { objects: {}, nextZ: 1 } }, activeCanvasId: 'c1', nextCanvasN: 2 };
    lockScreen.classList.add('hidden');
    pickerScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');

    VaultCanvas.init(canvasRoot, { onChange: onCanvasChange, minimapEl });
    VaultCanvas.loadState(vaultData.canvases[vaultData.activeCanvasId]);
    renderCanvasTabs();
    renderPinPanel();
    resetActivityTimer();
  }

  function lockVault() {
    sessionKey = null; // discard key from memory — nothing else identifies the plaintext
    vaultData = null;
    currentVaultId = null;
    VaultCanvas.destroy();
    canvasRoot.replaceWith(canvasRoot.cloneNode(false));
    canvasRoot = document.getElementById('canvas-root');
    appScreen.classList.add('hidden');
    pickerScreen.classList.remove('hidden');
    document.getElementById('unlock-password').value = '';
    showError('');
    clearInterval(autoLockTimer);
    renderVaultPicker();
  }

  // ---------------- auto-lock ----------------
  function resetActivityTimer() {
    lastActivity = Date.now();
    clearInterval(autoLockTimer);
    autoLockTimer = setInterval(() => {
      if (Date.now() - lastActivity >= AUTO_LOCK_MS) lockVault();
    }, 10000);
  }
  ['mousedown', 'keydown', 'mousemove', 'wheel'].forEach(evt => {
    window.addEventListener(evt, () => { if (currentVaultId) lastActivity = Date.now(); }, { passive: true });
  });

  // ---------------- autosave ----------------
  function onCanvasChange(canvasState) {
    if (!vaultData) return;
    // merge, don't replace — canvasState only carries {objects, nextZ}; preserve _name etc.
    vaultData.canvases[vaultData.activeCanvasId] = { ...vaultData.canvases[vaultData.activeCanvasId], ...canvasState };
    renderPinPanel();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveIndicator.textContent = 'Saving…';
    saveIndicator.classList.add('visible');
    saveTimer = setTimeout(async () => {
      try {
        await persistVault();
        flashSaved('Saved');
      } catch {
        flashSaved('Save failed');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function persistVault() {
    if (!sessionKey || !currentVaultId) return;
    const record = await VaultStorage.getVaultRecord(currentVaultId);
    const payload = await VaultCrypto.encrypt(sessionKey, vaultData);
    await VaultStorage.putVaultRecord(currentVaultId, { ...record, dataIv: payload.iv, dataCiphertext: payload.ciphertext });
  }

  // ---------------- canvas tabs (multiple canvases per vault) ----------------
  function switchCanvas(id) {
    if (id === vaultData.activeCanvasId) return;
    vaultData.canvases[vaultData.activeCanvasId] = { ...vaultData.canvases[vaultData.activeCanvasId], ...VaultCanvas.getState() };
    vaultData.activeCanvasId = id;
    VaultCanvas.loadState(vaultData.canvases[id]);
    renderCanvasTabs();
    renderPinPanel();
    scheduleSave();
  }

  function addCanvas() {
    const id = 'c' + (vaultData.nextCanvasN++);
    vaultData.canvases[vaultData.activeCanvasId] = { ...vaultData.canvases[vaultData.activeCanvasId], ...VaultCanvas.getState() };
    vaultData.canvases[id] = { objects: {}, nextZ: 1 };
    vaultData.activeCanvasId = id;
    VaultCanvas.loadState(vaultData.canvases[id]);
    renderCanvasTabs();
    renderPinPanel();
    scheduleSave();
  }

  function renameCanvas(id) {
    const cur = vaultData.canvases[id]._name || 'Canvas';
    const name = prompt('Canvas name:', cur);
    if (name === null) return;
    vaultData.canvases[id]._name = name;
    renderCanvasTabs();
    scheduleSave();
  }

  function deleteCanvas(id) {
    const ids = Object.keys(vaultData.canvases);
    if (ids.length <= 1) { alert("Can't delete your only canvas."); return; }
    if (!confirm('Delete this canvas and everything on it?')) return;
    delete vaultData.canvases[id];
    if (vaultData.activeCanvasId === id) {
      vaultData.activeCanvasId = Object.keys(vaultData.canvases)[0];
      VaultCanvas.loadState(vaultData.canvases[vaultData.activeCanvasId]);
    }
    renderCanvasTabs();
    renderPinPanel();
    scheduleSave();
  }

  function renderCanvasTabs() {
    canvasTabsEl.innerHTML = '';
    for (const [id, c] of Object.entries(vaultData.canvases)) {
      const tab = document.createElement('div');
      tab.className = 'canvas-tab' + (id === vaultData.activeCanvasId ? ' active' : '');
      tab.textContent = c._name || 'Canvas';
      tab.addEventListener('click', () => switchCanvas(id));
      tab.addEventListener('dblclick', () => renameCanvas(id));
      const closeBtn = document.createElement('span');
      closeBtn.className = 'canvas-tab-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', e => { e.stopPropagation(); deleteCanvas(id); });
      tab.appendChild(closeBtn);
      canvasTabsEl.appendChild(tab);
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'canvas-tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'New canvas';
    addBtn.addEventListener('click', addCanvas);
    canvasTabsEl.appendChild(addBtn);
  }

  // ---------------- pinned panel ----------------
  function renderPinPanel() {
    const pinned = VaultCanvas.getPinned();
    pinPanel.innerHTML = '';
    if (!pinned.length) { pinPanel.classList.add('hidden'); return; }
    pinPanel.classList.remove('hidden');
    const header = document.createElement('div');
    header.className = 'pin-panel-header';
    header.textContent = 'Pinned';
    pinPanel.appendChild(header);
    for (const p of pinned) {
      const item = document.createElement('button');
      item.className = 'pin-item';
      item.textContent = '★ ' + p.title;
      item.addEventListener('click', () => VaultCanvas.jumpToObject(p.id));
      pinPanel.appendChild(item);
    }
  }

  // ---------------- suggestions (local heuristic, opt-in) ----------------
  document.getElementById('suggest-btn').addEventListener('click', () => {
    const suggestions = VaultCanvas.suggestConnections();
    suggestPanel.innerHTML = '';
    if (!suggestions.length) {
      suggestPanel.innerHTML = '<div class="suggest-empty">No obvious overlaps found in your text cards right now.</div>';
    } else {
      const header = document.createElement('div');
      header.className = 'pin-panel-header';
      header.textContent = 'Possible connections (based on shared words in your notes — nothing is sent anywhere)';
      suggestPanel.appendChild(header);
      suggestions.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'suggest-row';
        row.innerHTML = `<span>${escapeHtmlLocal(s.aLabel)} ↔ ${escapeHtmlLocal(s.bLabel)}</span>`;
        const accept = document.createElement('button');
        accept.textContent = 'Connect';
        accept.addEventListener('click', () => {
          VaultCanvas.addObject({ type: 'arrow', x: 0, y: 0, w: 0, h: 0, data: { fromId: s.aId, toId: s.bId } });
          row.remove();
        });
        const dismiss = document.createElement('button');
        dismiss.textContent = 'Dismiss';
        dismiss.className = 'ghost';
        dismiss.addEventListener('click', () => row.remove());
        row.appendChild(accept);
        row.appendChild(dismiss);
        suggestPanel.appendChild(row);
      });
    }
    suggestPanel.classList.toggle('hidden');
  });
  function escapeHtmlLocal(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ---------------- graph auto-layout ----------------
  document.getElementById('graph-btn').addEventListener('click', () => {
    const did = VaultCanvas.autoLayoutGraph();
    if (!did) alert('Connect at least two cards with arrows first — graph layout arranges connected cards.');
  });

  // ---------------- forms ----------------
  setupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('setup-vault-name').value.trim() || 'My Vault';
    const p1 = document.getElementById('setup-password').value;
    const p2 = document.getElementById('setup-password-confirm').value;
    if (p1.length < 8) return showError('Use at least 8 characters.');
    if (p1 !== p2) return showError('Passwords do not match.');
    showError('');
    await createVault(name, p1);
  });

  unlockForm.addEventListener('submit', async e => {
    e.preventDefault();
    const p = document.getElementById('unlock-password').value;
    await unlockVault(unlockTargetVaultId, unlockTargetVaultName, p);
  });

  document.getElementById('lock-btn').addEventListener('click', lockVault);

  // ---------------- toolbar: create objects ----------------
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

  document.getElementById('add-frame-btn').addEventListener('click', () => VaultCanvas.addFrameAtCenter());

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
    connectBtn.classList.remove('active'); connectActive = false;
  });

  let connectActive = false;
  const connectBtn = document.getElementById('connect-btn');
  connectBtn.addEventListener('click', () => {
    connectActive = !connectActive;
    connectBtn.classList.toggle('active', connectActive);
    VaultCanvas.setMode(connectActive ? 'connect' : 'select');
    drawBtn.classList.remove('active'); drawActive = false;
  });

  // ---------------- audio recording ----------------
  let mediaRecorder = null, audioChunks = [];
  const audioBtn = document.getElementById('audio-btn');
  audioBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        audioBtn.classList.remove('active');
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => VaultCanvas.addAudioAtCenter(reader.result);
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start();
      audioBtn.classList.add('active');
    } catch (err) {
      alert("Couldn't access the microphone. Check your browser's permission settings.");
    }
  });

  document.getElementById('undo-btn').addEventListener('click', () => VaultCanvas.undo());
  document.getElementById('redo-btn').addEventListener('click', () => VaultCanvas.redo());
  document.getElementById('zoom-in-btn').addEventListener('click', () => VaultCanvas.zoomAt(canvasRoot.clientWidth / 2, canvasRoot.clientHeight / 2, 1.2));
  document.getElementById('zoom-out-btn').addEventListener('click', () => VaultCanvas.zoomAt(canvasRoot.clientWidth / 2, canvasRoot.clientHeight / 2, 1 / 1.2));
  document.getElementById('zoom-reset-btn').addEventListener('click', () => VaultCanvas.resetView());

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const matches = VaultCanvas.search(searchInput.value);
    const cards = canvasRoot.querySelectorAll('.vault-card, .vault-frame');
    cards.forEach(c => {
      if (matches === null) { c.classList.remove('dimmed'); return; }
      c.classList.toggle('dimmed', !matches.has(c.dataset.id));
    });
  });

  // ---------------- encrypted export / import ----------------
  document.getElementById('export-btn').addEventListener('click', async () => {
    if (!currentVaultId) return;
    await persistVault(); // make sure the file we export reflects the latest edits, not the last debounce tick
    const record = await VaultStorage.getVaultRecord(currentVaultId);
    const exportPayload = { vaultExport: true, version: 1, name: currentVaultName, ...record };
    const blob = new Blob([JSON.stringify(exportPayload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentVaultName.replace(/[^a-z0-9-_]+/gi, '_')}.vaultbackup.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const importInput = document.getElementById('import-input');
  document.getElementById('import-btn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try { parsed = JSON.parse(reader.result); } catch { alert('That file is not a valid Vault backup.'); return; }
      const required = ['salt', 'iterations', 'verifierIv', 'verifierCiphertext', 'dataIv', 'dataCiphertext'];
      if (!parsed.vaultExport || !required.every(k => k in parsed)) {
        alert('That file is not a valid Vault backup.');
        return;
      }
      const id = VaultStorage.newVaultId();
      const record = {
        salt: parsed.salt, iterations: parsed.iterations,
        verifierIv: parsed.verifierIv, verifierCiphertext: parsed.verifierCiphertext,
        dataIv: parsed.dataIv, dataCiphertext: parsed.dataCiphertext,
      };
      let name = parsed.name || 'Imported Vault';
      const existing = await VaultStorage.listVaults();
      if (existing.some(v => v.name === name)) name = name + ' (imported)';
      await VaultStorage.putVaultRecord(id, record);
      await VaultStorage.addToIndex(id, name);
      await renderVaultPicker();
      alert(`Imported as "${name}". Unlock it with the password it was created with — importing a file never bypasses that.`);
    };
    reader.readAsText(file);
  });

  // ---------------- boot ----------------
  renderVaultPicker();
})();
