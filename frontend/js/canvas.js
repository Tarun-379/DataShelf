/**
 * Vault.Canvas
 * -------------------------------------------------------------
 * A dependency-free infinite canvas engine. Objects are plain
 * DOM nodes positioned inside a single transformed "world" div
 * (translate + scale), so pan/zoom is one CSS transform.
 *
 * Data model:
 *   { id, type, x, y, w, h, z, createdAt, updatedAt, data }
 *   type ∈ 'text' | 'image' | 'drawing' | 'link' | 'arrow' | 'frame' | 'audio'
 *   arrow: data = { fromId, toId }
 *   frame: data = { title, color }  — dragging a frame drags any card
 *          whose center was inside it when the drag started
 *   text:  data = { title, body, color, pinned }
 *          body supports **bold**, *italic*, `code`, and "- [ ] " checkboxes
 * -------------------------------------------------------------
 */
const VaultCanvas = (() => {
  let root, world, svgLayer, objectLayer, selectionBox, guideLayer;
  let minimapEl = null;
  let state = { objects: {}, nextZ: 1 };
  let selected = new Set();
  let viewport = { x: 0, y: 0, scale: 1 };
  let onChange = () => {};

  const CARD_COLORS = ['default', 'amber', 'rose', 'teal', 'violet'];
  const SNAP_THRESHOLD = 6; // world units, adjusted for zoom when comparing

  // ---- history (undo/redo) ----
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 100;
  let suppressHistory = false;

  function snapshot() { return JSON.parse(JSON.stringify(state)); }

  function pushHistory() {
    if (suppressHistory) return;
    undoStack.push(snapshot());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    state = undoStack.pop();
    selected.clear();
    render();
    notifyChange();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    state = redoStack.pop();
    selected.clear();
    render();
    notifyChange();
  }

  function notifyChange() { onChange(state); }

  // ---- coordinate helpers ----
  function screenToWorld(sx, sy) {
    const rect = root.getBoundingClientRect();
    return { x: (sx - rect.left - viewport.x) / viewport.scale, y: (sy - rect.top - viewport.y) / viewport.scale };
  }

  function applyViewportTransform() {
    world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
    renderMinimap();
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = root.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const newScale = Math.min(3, Math.max(0.15, viewport.scale * factor));
    viewport.x = cx - ((cx - viewport.x) / viewport.scale) * newScale;
    viewport.y = cy - ((cy - viewport.y) / viewport.scale) * newScale;
    viewport.scale = newScale;
    applyViewportTransform();
  }

  function resetView() {
    viewport = { x: root.clientWidth / 2, y: root.clientHeight / 2, scale: 1 };
    applyViewportTransform();
  }

  function panTo(worldX, worldY) {
    viewport.x = root.clientWidth / 2 - worldX * viewport.scale;
    viewport.y = root.clientHeight / 2 - worldY * viewport.scale;
    applyViewportTransform();
  }

  function jumpToObject(id) {
    const obj = state.objects[id];
    if (!obj) return;
    panTo(obj.x + obj.w / 2, obj.y + obj.h / 2);
    selected = new Set([id]);
    render();
  }

  // ---- object CRUD ----
  function genId() { return 'o_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  function addObject(partial, { record = true } = {}) {
    if (record) pushHistory();
    const now = Date.now();
    const obj = {
      id: genId(), x: 0, y: 0, w: 220, h: 120, z: state.nextZ++,
      createdAt: now, updatedAt: now, data: {}, ...partial,
    };
    state.objects[obj.id] = obj;
    render();
    notifyChange();
    return obj;
  }

  function updateObject(id, patch, { record = true } = {}) {
    const obj = state.objects[id];
    if (!obj) return;
    if (record) pushHistory();
    // pull `data` out before Object.assign — assigning it directly would replace
    // obj.data wholesale, clobbering any fields not present in this particular patch
    const { data: dataPatch, ...rest } = patch;
    Object.assign(obj, rest, { updatedAt: Date.now() });
    if (dataPatch) obj.data = { ...obj.data, ...dataPatch };
    render();
    notifyChange();
  }

  function deleteObjects(ids) {
    if (!ids.length) return;
    pushHistory();
    const idSet = new Set(ids);
    for (const id of ids) delete state.objects[id];
    for (const [oid, o] of Object.entries(state.objects)) {
      if (o.type === 'arrow' && (idSet.has(o.data.fromId) || idSet.has(o.data.toId))) delete state.objects[oid];
    }
    selected.clear();
    render();
    notifyChange();
  }

  function bringToFront(id) {
    const obj = state.objects[id];
    if (!obj) return;
    obj.z = state.nextZ++;
  }

  function cycleColor(id) {
    const obj = state.objects[id];
    if (!obj) return;
    const cur = (obj.data && obj.data.color) || 'default';
    const next = CARD_COLORS[(CARD_COLORS.indexOf(cur) + 1) % CARD_COLORS.length];
    updateObject(id, { data: { color: next } });
  }

  function togglePin(id) {
    const obj = state.objects[id];
    if (!obj) return;
    updateObject(id, { data: { pinned: !obj.data.pinned } });
  }

  function getPinned() {
    return Object.values(state.objects)
      .filter(o => o.type !== 'arrow' && o.data && o.data.pinned)
      .map(o => ({ id: o.id, title: cardLabel(o) }));
  }

  function cardLabel(o) {
    if (o.type === 'text') return (o.data.title || o.data.body || '(untitled)').slice(0, 40);
    if (o.type === 'link') return o.data.url || 'link';
    if (o.type === 'frame') return o.data.title || 'frame';
    return o.type;
  }

  // ---- selection ----
  function clearSelection() { selected.clear(); render(); }
  function selectAll() { selected = new Set(Object.keys(state.objects).filter(id => state.objects[id].type !== 'arrow')); render(); }

  // ---- search index (rebuilt on render; cheap at MVP scale, O(1) lookup after) ----
  let searchIndex = new Map(); // token -> Set(objectId)

  function tokenize(text) {
    return (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  function rebuildSearchIndex() {
    searchIndex = new Map();
    for (const o of Object.values(state.objects)) {
      if (o.type === 'arrow') continue;
      const text = [o.data.title, o.data.body, o.data.url].filter(Boolean).join(' ');
      for (const tok of new Set(tokenize(text))) {
        if (!searchIndex.has(tok)) searchIndex.set(tok, new Set());
        searchIndex.get(tok).add(o.id);
      }
    }
  }

  function search(query) {
    const tokens = tokenize(query);
    if (!tokens.length) return null; // null = "no filter"
    let matches = null;
    for (const tok of tokens) {
      // prefix match so partial words still work, e.g. "budg" -> "budget"
      let hitIds = new Set();
      for (const [key, ids] of searchIndex.entries()) {
        if (key.startsWith(tok)) for (const id of ids) hitIds.add(id);
      }
      matches = matches === null ? hitIds : new Set([...matches].filter(id => hitIds.has(id)));
    }
    return matches || new Set();
  }

  // ---- connection suggestions (local heuristic — no network call, no AI service; opt-in only) ----
  function suggestConnections() {
    const existingPairs = new Set();
    for (const o of Object.values(state.objects)) {
      if (o.type === 'arrow') existingPairs.add([o.data.fromId, o.data.toId].sort().join('|'));
    }
    const cards = Object.values(state.objects).filter(o => o.type === 'text' && (o.data.body || o.data.title));
    const tokenSets = cards.map(c => ({ id: c.id, label: cardLabel(c), tokens: new Set(tokenize((c.data.title || '') + ' ' + (c.data.body || ''))) }));
    const results = [];
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        const a = tokenSets[i], b = tokenSets[j];
        const pairKey = [a.id, b.id].sort().join('|');
        if (existingPairs.has(pairKey)) continue;
        const intersection = [...a.tokens].filter(t => b.tokens.has(t)).length;
        const union = new Set([...a.tokens, ...b.tokens]).size;
        if (!union) continue;
        const score = intersection / union;
        if (score > 0.15 && intersection >= 2) {
          results.push({ aId: a.id, bId: b.id, aLabel: a.label, bLabel: b.label, score });
        }
      }
    }
    return results.sort((x, y) => y.score - x.score).slice(0, 8);
  }

  // ---- graph auto-layout (simple force-directed pass; one undoable step) ----
  function autoLayoutGraph() {
    const arrows = Object.values(state.objects).filter(o => o.type === 'arrow');
    const nodeIds = new Set();
    arrows.forEach(a => { nodeIds.add(a.data.fromId); nodeIds.add(a.data.toId); });
    const nodes = [...nodeIds].map(id => state.objects[id]).filter(Boolean);
    if (nodes.length < 2) return false;

    pushHistory();
    const pos = {};
    nodes.forEach(n => { pos[n.id] = { x: n.x + n.w / 2, y: n.y + n.h / 2, vx: 0, vy: 0 }; });

    const REPULSION = 60000, ATTRACTION = 0.02, DAMPING = 0.85, ITER = 200;
    for (let iter = 0; iter < ITER; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const A = pos[nodes[i].id], B = pos[nodes[j].id];
          let dx = A.x - B.x, dy = A.y - B.y;
          let distSq = dx * dx + dy * dy || 0.01;
          const force = REPULSION / distSq;
          const dist = Math.sqrt(distSq) || 1;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
        }
      }
      for (const arrow of arrows) {
        const A = pos[arrow.data.fromId], B = pos[arrow.data.toId];
        if (!A || !B) continue;
        const dx = B.x - A.x, dy = B.y - A.y;
        A.vx += dx * ATTRACTION; A.vy += dy * ATTRACTION;
        B.vx -= dx * ATTRACTION; B.vy -= dy * ATTRACTION;
      }
      for (const n of nodes) {
        const p = pos[n.id];
        p.vx *= DAMPING; p.vy *= DAMPING;
        p.x += p.vx; p.y += p.vy;
      }
    }
    for (const n of nodes) {
      const p = pos[n.id];
      updateObject(n.id, { x: p.x - n.w / 2, y: p.y - n.h / 2 }, { record: false });
    }
    render();
    notifyChange();
    return true;
  }

  // ---- markdown-lite ----
  function escapeHtml(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  function renderMarkdownLite(raw) {
    const lines = (raw || '').split('\n');
    return lines.map((line, idx) => {
      const checkboxMatch = line.match(/^(\s*)-\s*\[( |x|X)\]\s+(.*)$/);
      if (checkboxMatch) {
        const checked = checkboxMatch[2].toLowerCase() === 'x';
        const label = inlineMd(checkboxMatch[3]);
        return `<div class="md-checkbox-line" data-line="${idx}"><input type="checkbox" ${checked ? 'checked' : ''} data-line="${idx}"/><span class="${checked ? 'md-done' : ''}">${label}</span></div>`;
      }
      return `<div class="md-line">${inlineMd(line) || '&nbsp;'}</div>`;
    }).join('');
  }

  function inlineMd(text) {
    let t = escapeHtml(text);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    return t;
  }

  function toggleCheckboxLine(rawBody, lineIdx) {
    const lines = rawBody.split('\n');
    const line = lines[lineIdx];
    if (!line) return rawBody;
    if (/\[ \]/.test(line)) lines[lineIdx] = line.replace('[ ]', '[x]');
    else if (/\[x\]/i.test(line)) lines[lineIdx] = line.replace(/\[x\]/i, '[ ]');
    return lines.join('\n');
  }

  // ---- rendering ----
  function render() {
    rebuildSearchIndex();
    objectLayer.innerHTML = '';
    svgLayer.innerHTML = svgLayer.querySelector('defs') ? svgLayer.querySelector('defs').outerHTML : '';
    const objs = Object.values(state.objects).sort((a, b) => a.z - b.z);
    for (const obj of objs) {
      if (obj.type === 'frame') renderFrame(obj);
    }
    for (const obj of objs) {
      if (obj.type === 'arrow') renderArrow(obj);
      else if (obj.type !== 'frame') renderCard(obj);
    }
    renderMinimap();
  }

  function renderArrow(obj) {
    const from = state.objects[obj.data.fromId];
    const to = state.objects[obj.data.toId];
    if (!from || !to) return;
    const p1 = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const p2 = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
    line.setAttribute('class', 'vault-arrow-line');
    line.setAttribute('marker-end', 'url(#arrowhead)');
    svgLayer.appendChild(line);
  }

  function renderFrame(obj) {
    const el = document.createElement('div');
    el.className = 'vault-frame' + (selected.has(obj.id) ? ' selected' : '');
    el.dataset.id = obj.id;
    el.dataset.type = 'frame';
    el.style.left = obj.x + 'px'; el.style.top = obj.y + 'px';
    el.style.width = obj.w + 'px'; el.style.height = obj.h + 'px';
    el.style.zIndex = obj.z;
    el.style.borderColor = frameColorVar(obj.data.color);
    el.innerHTML = `
      <div class="frame-title" data-role="drag">${escapeHtml(obj.data.title || 'Frame')}</div>
      <div class="resize-handle"></div>
    `;
    const titleEl = el.querySelector('.frame-title');
    titleEl.addEventListener('dblclick', e => {
      e.stopPropagation();
      const v = prompt('Frame name:', obj.data.title || '');
      if (v !== null) updateObject(obj.id, { data: { title: v } });
    });
    objectLayer.appendChild(el);
  }

  function frameColorVar(c) {
    return { amber: '#c9a24a', rose: '#c96a86', teal: '#4aa38f', violet: '#8a7fd6' }[c] || 'var(--border)';
  }

  function renderCard(obj) {
    const el = document.createElement('div');
    const colorClass = obj.data && obj.data.color && obj.data.color !== 'default' ? ` color-${obj.data.color}` : '';
    el.className = `vault-card vault-${obj.type}${colorClass}` + (selected.has(obj.id) ? ' selected' : '');
    el.style.left = obj.x + 'px'; el.style.top = obj.y + 'px';
    el.style.width = obj.w + 'px'; el.style.height = obj.h + 'px';
    el.style.zIndex = obj.z;
    el.dataset.id = obj.id;

    const pinBtn = `<button class="pin-btn ${obj.data.pinned ? 'pinned' : ''}" title="Pin">${obj.data.pinned ? '★' : '☆'}</button>`;
    const colorBtn = `<button class="color-btn" title="Cycle color"><span class="swatch"></span></button>`;

    if (obj.type === 'text') {
      el.innerHTML = `
        <div class="card-head" data-role="drag">
          <input class="card-title" placeholder="Title (optional)" value="${escapeAttr(obj.data.title || '')}"/>
          ${colorBtn}${pinBtn}
        </div>
        <div class="card-body-render">${renderMarkdownLite(obj.data.body || '')}</div>
        <textarea class="card-body-edit hidden" placeholder="Write anything... **bold** *italic* \`code\` - [ ] todo">${escapeHtml(obj.data.body || '')}</textarea>
      `;
      const titleInput = el.querySelector('.card-title');
      const renderDiv = el.querySelector('.card-body-render');
      const editArea = el.querySelector('.card-body-edit');

      titleInput.addEventListener('change', () => updateObject(obj.id, { data: { title: titleInput.value } }));
      titleInput.addEventListener('mousedown', e => e.stopPropagation());

      renderDiv.addEventListener('mousedown', e => {
        if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') return; // handled by click below
        e.stopPropagation();
      });
      renderDiv.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') {
          e.stopPropagation();
          const lineIdx = parseInt(e.target.dataset.line, 10);
          const newBody = toggleCheckboxLine(obj.data.body || '', lineIdx);
          updateObject(obj.id, { data: { body: newBody } });
          return;
        }
        renderDiv.classList.add('hidden');
        editArea.classList.remove('hidden');
        editArea.focus();
      });
      editArea.addEventListener('mousedown', e => e.stopPropagation());
      editArea.addEventListener('blur', () => {
        updateObject(obj.id, { data: { body: editArea.value } });
      });
    } else if (obj.type === 'image') {
      el.innerHTML = `<div class="card-head" data-role="drag">${colorBtn}${pinBtn}</div><img src="${obj.data.src}" class="card-img" draggable="false"/>`;
    } else if (obj.type === 'link') {
      el.innerHTML = `
        <div class="card-head" data-role="drag">🔗${colorBtn}${pinBtn}</div>
        <a href="${escapeAttr(obj.data.url || '#')}" target="_blank" rel="noopener noreferrer" class="card-link">${escapeHtml(obj.data.url || '')}</a>
      `;
      el.querySelector('a').addEventListener('mousedown', e => e.stopPropagation());
    } else if (obj.type === 'audio') {
      el.innerHTML = `
        <div class="card-head" data-role="drag">🎙${colorBtn}${pinBtn}</div>
        <audio controls src="${obj.data.src}" class="card-audio"></audio>
      `;
      el.querySelector('audio').addEventListener('mousedown', e => e.stopPropagation());
    } else if (obj.type === 'drawing') {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${obj.w} ${obj.h}`);
      svg.classList.add('card-drawing-svg');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', obj.data.path || '');
      path.setAttribute('class', 'drawing-path');
      svg.appendChild(path);
      el.appendChild(svg);
    }

    // wire color/pin buttons (present on all card types that included them)
    const colorBtnEl = el.querySelector('.color-btn');
    if (colorBtnEl) {
      colorBtnEl.style.setProperty('--swatch-color', swatchColor(obj.data.color));
      colorBtnEl.addEventListener('mousedown', e => e.stopPropagation());
      colorBtnEl.addEventListener('click', e => { e.stopPropagation(); cycleColor(obj.id); });
    }
    const pinBtnEl = el.querySelector('.pin-btn');
    if (pinBtnEl) {
      pinBtnEl.addEventListener('mousedown', e => e.stopPropagation());
      pinBtnEl.addEventListener('click', e => { e.stopPropagation(); togglePin(obj.id); });
    }

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);

    objectLayer.appendChild(el);
  }

  function swatchColor(c) {
    return { amber: '#e0b74f', rose: '#e08aa3', teal: '#5fc7ae', violet: '#a89bee', default: '#3a3f4a' }[c || 'default'];
  }

  // ---- minimap ----
  function renderMinimap() {
    if (!minimapEl) return;
    const objs = Object.values(state.objects).filter(o => o.type !== 'arrow');
    minimapEl.innerHTML = '';
    if (objs.length < 8) { minimapEl.classList.add('hidden'); return; } // only useful once things spread out
    minimapEl.classList.remove('hidden');

    const pad = 40;
    const minX = Math.min(...objs.map(o => o.x)) - pad;
    const minY = Math.min(...objs.map(o => o.y)) - pad;
    const maxX = Math.max(...objs.map(o => o.x + o.w)) + pad;
    const maxY = Math.max(...objs.map(o => o.y + o.h)) + pad;
    const worldW = Math.max(1, maxX - minX), worldH = Math.max(1, maxY - minY);
    const mmW = minimapEl.clientWidth || 160, mmH = minimapEl.clientHeight || 120;
    const scale = Math.min(mmW / worldW, mmH / worldH);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${mmW} ${mmH}`);
    svg.classList.add('minimap-svg');

    for (const o of objs) {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', (o.x - minX) * scale);
      r.setAttribute('y', (o.y - minY) * scale);
      r.setAttribute('width', Math.max(2, o.w * scale));
      r.setAttribute('height', Math.max(2, o.h * scale));
      r.setAttribute('class', 'minimap-node');
      svg.appendChild(r);
    }

    // current viewport rect
    const viewWorldX = -viewport.x / viewport.scale;
    const viewWorldY = -viewport.y / viewport.scale;
    const viewWorldW = root.clientWidth / viewport.scale;
    const viewWorldH = root.clientHeight / viewport.scale;
    const vr = document.createElementNS(ns, 'rect');
    vr.setAttribute('x', (viewWorldX - minX) * scale);
    vr.setAttribute('y', (viewWorldY - minY) * scale);
    vr.setAttribute('width', viewWorldW * scale);
    vr.setAttribute('height', viewWorldH * scale);
    vr.setAttribute('class', 'minimap-viewport');
    svg.appendChild(vr);

    minimapEl.appendChild(svg);
    minimapEl._mapMeta = { minX, minY, scale };
  }

  function onMinimapClick(e) {
    if (!minimapEl._mapMeta) return;
    const rect = minimapEl.getBoundingClientRect();
    const { minX, minY, scale } = minimapEl._mapMeta;
    const worldX = minX + (e.clientX - rect.left) / scale;
    const worldY = minY + (e.clientY - rect.top) / scale;
    panTo(worldX, worldY);
  }

  // ---- interaction state ----
  let mode = 'select'; // 'select' | 'draw' | 'connect'
  let spaceHeld = false;
  let drag = null;
  let connectFromId = null;

  function setMode(m) {
    mode = m;
    connectFromId = null;
    root.classList.toggle('mode-draw', m === 'draw');
    root.classList.toggle('mode-connect', m === 'connect');
  }

  function childrenInsideFrame(frame) {
    return Object.values(state.objects).filter(o => {
      if (o.id === frame.id || o.type === 'arrow' || o.type === 'frame') return false;
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
    }).map(o => o.id);
  }

  function clearGuides() { guideLayer.innerHTML = ''; }

  function drawGuide(orientation, coordWorld) {
    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'line');
    const SPAN = 100000;
    if (orientation === 'v') {
      line.setAttribute('x1', coordWorld); line.setAttribute('x2', coordWorld);
      line.setAttribute('y1', -SPAN); line.setAttribute('y2', SPAN);
    } else {
      line.setAttribute('y1', coordWorld); line.setAttribute('y2', coordWorld);
      line.setAttribute('x1', -SPAN); line.setAttribute('x2', SPAN);
    }
    line.setAttribute('class', 'align-guide');
    guideLayer.appendChild(line);
  }

  function computeSnap(movingObj, dx, dy) {
    const threshold = SNAP_THRESHOLD / viewport.scale;
    let snappedDx = dx, snappedDy = dy;
    clearGuides();
    const proposedX = movingObj.x + dx, proposedY = movingObj.y + dy;
    const edgesX = [proposedX, proposedX + movingObj.w / 2, proposedX + movingObj.w];
    const edgesY = [proposedY, proposedY + movingObj.h / 2, proposedY + movingObj.h];
    let bestDx = null, bestDy = null;

    for (const o of Object.values(state.objects)) {
      if (o.id === movingObj.id || o.type === 'arrow') continue;
      const oEdgesX = [o.x, o.x + o.w / 2, o.x + o.w];
      const oEdgesY = [o.y, o.y + o.h / 2, o.y + o.h];
      for (const ex of edgesX) for (const oex of oEdgesX) {
        if (Math.abs(ex - oex) < threshold && (bestDx === null || Math.abs(ex - oex) < Math.abs(bestDx.diff))) {
          bestDx = { diff: ex - oex, guideAt: oex };
        }
      }
      for (const ey of edgesY) for (const oey of oEdgesY) {
        if (Math.abs(ey - oey) < threshold && (bestDy === null || Math.abs(ey - oey) < Math.abs(bestDy.diff))) {
          bestDy = { diff: ey - oey, guideAt: oey };
        }
      }
    }
    if (bestDx) { snappedDx = dx - bestDx.diff; drawGuide('v', bestDx.guideAt); }
    if (bestDy) { snappedDy = dy - bestDy.diff; drawGuide('h', bestDy.guideAt); }
    return { dx: snappedDx, dy: snappedDy };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    const targetCard = e.target.closest('.vault-card, .vault-frame');
    const onHandle = e.target.classList.contains('resize-handle');

    if (spaceHeld) { drag = { type: 'pan', startX: e.clientX, startY: e.clientY, ox: viewport.x, oy: viewport.y }; return; }

    if (mode === 'draw') { drag = { type: 'draw', points: [worldPos] }; return; }

    if (mode === 'connect') {
      if (targetCard && targetCard.dataset.type !== 'frame') {
        const id = targetCard.dataset.id;
        if (!connectFromId) connectFromId = id;
        else if (connectFromId !== id) {
          addObject({ type: 'arrow', x: 0, y: 0, w: 0, h: 0, data: { fromId: connectFromId, toId: id } });
          connectFromId = null;
          setMode('select');
        }
      }
      return;
    }

    if (onHandle && targetCard) {
      const id = targetCard.dataset.id;
      const obj = state.objects[id];
      pushHistory();
      drag = { type: 'resize', id, startW: obj.w, startH: obj.h, startX: e.clientX, startY: e.clientY, scale: viewport.scale };
      return;
    }

    if (targetCard) {
      const id = targetCard.dataset.id;
      const obj = state.objects[id];
      if (!selected.has(id)) { if (!e.shiftKey) selected.clear(); selected.add(id); }
      bringToFront(id);
      pushHistory();
      let idsToMove = [...selected];
      if (obj.type === 'frame' && selected.size === 1) idsToMove = idsToMove.concat(childrenInsideFrame(obj));
      drag = {
        type: 'move', startX: e.clientX, startY: e.clientY, scale: viewport.scale,
        primaryId: id,
        origins: [...new Set(idsToMove)].map(sid => ({ id: sid, x: state.objects[sid].x, y: state.objects[sid].y })),
      };
      render();
      return;
    }

    if (!e.shiftKey) { selected.clear(); render(); }
    drag = { type: 'pending-rubberband', startScreen: { x: e.clientX, y: e.clientY }, worldStart: worldPos };
  }

  function onPointerMove(e) {
    if (!drag) return;

    if (drag.type === 'pan') {
      viewport.x = drag.ox + (e.clientX - drag.startX);
      viewport.y = drag.oy + (e.clientY - drag.startY);
      applyViewportTransform();
      return;
    }
    if (drag.type === 'draw') { drag.points.push(screenToWorld(e.clientX, e.clientY)); drawLivePath(drag.points); return; }

    if (drag.type === 'move') {
      let dx = (e.clientX - drag.startX) / drag.scale;
      let dy = (e.clientY - drag.startY) / drag.scale;
      const primary = state.objects[drag.primaryId];
      const primaryOrigin = drag.origins.find(o => o.id === drag.primaryId);
      if (primary && primaryOrigin) {
        const virtualPrimary = { id: primary.id, w: primary.w, h: primary.h, x: primaryOrigin.x, y: primaryOrigin.y };
        const snapped = computeSnap(virtualPrimary, dx, dy);
        dx = snapped.dx; dy = snapped.dy;
      }
      for (const o of drag.origins) { state.objects[o.id].x = o.x + dx; state.objects[o.id].y = o.y + dy; }
      render();
      return;
    }

    if (drag.type === 'resize') {
      const dx = (e.clientX - drag.startX) / drag.scale;
      const dy = (e.clientY - drag.startY) / drag.scale;
      const obj = state.objects[drag.id];
      obj.w = Math.max(60, drag.startW + dx);
      obj.h = Math.max(40, drag.startH + dy);
      render();
      return;
    }

    if (drag.type === 'pending-rubberband') {
      const distMoved = Math.hypot(e.clientX - drag.startScreen.x, e.clientY - drag.startScreen.y);
      if (distMoved > 4) { drag.type = 'rubberband'; selectionBox.style.display = 'block'; }
      else return;
    }

    if (drag.type === 'rubberband') {
      const cur = screenToWorld(e.clientX, e.clientY);
      const x1 = Math.min(drag.worldStart.x, cur.x), x2 = Math.max(drag.worldStart.x, cur.x);
      const y1 = Math.min(drag.worldStart.y, cur.y), y2 = Math.max(drag.worldStart.y, cur.y);
      selectionBox.style.left = (viewport.x + x1 * viewport.scale) + 'px';
      selectionBox.style.top = (viewport.y + y1 * viewport.scale) + 'px';
      selectionBox.style.width = ((x2 - x1) * viewport.scale) + 'px';
      selectionBox.style.height = ((y2 - y1) * viewport.scale) + 'px';
      selected.clear();
      for (const [id, o] of Object.entries(state.objects)) {
        if (o.type === 'arrow') continue;
        if (o.x >= x1 && o.y >= y1 && o.x + o.w <= x2 && o.y + o.h <= y2) selected.add(id);
      }
      render();
    }
  }

  function drawLivePath(points) {
    let temp = svgLayer.querySelector('#live-draw-path');
    const d = pointsToPath(points);
    if (!temp) {
      const ns = 'http://www.w3.org/2000/svg';
      temp = document.createElementNS(ns, 'path');
      temp.id = 'live-draw-path';
      temp.setAttribute('class', 'drawing-path live');
      svgLayer.appendChild(temp);
    }
    temp.setAttribute('d', d);
  }

  function pointsToPath(points) {
    if (!points.length) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  }

  function onPointerUp() {
    if (!drag) return;
    clearGuides();

    if (drag.type === 'draw') {
      const pts = drag.points;
      const live = svgLayer.querySelector('#live-draw-path');
      if (live) live.remove();
      if (pts.length > 1) {
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const w = Math.max(20, Math.max(...xs) - minX), h = Math.max(20, Math.max(...ys) - minY);
        const relPath = pointsToPath(pts.map(p => ({ x: p.x - minX, y: p.y - minY })));
        addObject({ type: 'drawing', x: minX, y: minY, w, h, data: { path: relPath } });
      }
    }
    if (drag.type === 'rubberband') selectionBox.style.display = 'none';
    drag = null;
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      viewport.x -= e.deltaX; viewport.y -= e.deltaY;
      applyViewportTransform();
    }
  }

  function onDblClick(e) {
    if (e.target.closest('.vault-card, .vault-frame')) return;
    if (mode !== 'select') return;
    const pos = screenToWorld(e.clientX, e.clientY);
    const obj = addObject({ type: 'text', x: pos.x - 110, y: pos.y - 60, w: 220, h: 120, data: { title: '', body: '' } });
    requestAnimationFrame(() => {
      const editArea = objectLayer.querySelector(`[data-id="${obj.id}"] .card-body-edit`);
      const renderDiv = objectLayer.querySelector(`[data-id="${obj.id}"] .card-body-render`);
      if (editArea && renderDiv) { renderDiv.classList.add('hidden'); editArea.classList.remove('hidden'); editArea.focus(); }
    });
  }

  function onKeyDown(e) {
    const activeTag = document.activeElement && document.activeElement.tagName;
    const typing = activeTag === 'TEXTAREA' || activeTag === 'INPUT';

    if (e.code === 'Space' && !typing) { spaceHeld = true; root.classList.add('space-pan'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); selectAll(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selected.size) { e.preventDefault(); deleteObjects([...selected]); return; }
    if (e.key === 'Escape') { selected.clear(); connectFromId = null; setMode('select'); render(); }
  }
  function onKeyUp(e) { if (e.code === 'Space') { spaceHeld = false; root.classList.remove('space-pan'); } }

  function addImageAtCenter(dataUrl, atWorldPos) {
    const img = new Image();
    img.onload = () => {
      const maxDim = 320;
      const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = img.width * ratio || 200, h = img.height * ratio || 200;
      const pos = atWorldPos || screenToWorld(root.clientWidth / 2 + root.getBoundingClientRect().left, root.clientHeight / 2 + root.getBoundingClientRect().top);
      addObject({ type: 'image', x: pos.x - w / 2, y: pos.y - h / 2, w, h, data: { src: dataUrl } });
    };
    img.src = dataUrl;
  }

  function addAudioAtCenter(dataUrl) {
    const pos = screenToWorld(root.clientWidth / 2 + root.getBoundingClientRect().left, root.clientHeight / 2 + root.getBoundingClientRect().top);
    addObject({ type: 'audio', x: pos.x - 110, y: pos.y - 30, w: 240, h: 60, data: { src: dataUrl } });
  }

  function addFrameAtCenter() {
    const pos = screenToWorld(root.clientWidth / 2 + root.getBoundingClientRect().left, root.clientHeight / 2 + root.getBoundingClientRect().top);
    addObject({ type: 'frame', x: pos.x - 200, y: pos.y - 150, w: 400, h: 300, data: { title: 'Frame' } });
  }

  function onDrop(e) {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const pos = screenToWorld(e.clientX, e.clientY);
    files.forEach(f => {
      const reader = new FileReader();
      reader.onload = () => addImageAtCenter(reader.result, pos);
      reader.readAsDataURL(f);
    });
  }

  let boundHandlers = null;
  function destroy() {
    if (!boundHandlers) return;
    window.removeEventListener('mousemove', boundHandlers.move);
    window.removeEventListener('mouseup', boundHandlers.up);
    window.removeEventListener('keydown', boundHandlers.keydown);
    window.removeEventListener('keyup', boundHandlers.keyup);
    boundHandlers = null;
  }

  function init(container, opts = {}) {
    destroy();
    root = container;
    onChange = opts.onChange || (() => {});
    minimapEl = opts.minimapEl || null;
    root.innerHTML = `
      <div class="vault-world" id="vault-world">
        <svg class="vault-svg-layer" id="vault-svg-layer">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z" class="arrowhead-fill" />
            </marker>
          </defs>
        </svg>
        <svg class="vault-guide-layer" id="vault-guide-layer"></svg>
        <div class="vault-object-layer" id="vault-object-layer"></div>
      </div>
      <div class="vault-selection-box" id="vault-selection-box"></div>
    `;
    world = root.querySelector('#vault-world');
    svgLayer = root.querySelector('#vault-svg-layer');
    guideLayer = root.querySelector('#vault-guide-layer');
    objectLayer = root.querySelector('#vault-object-layer');
    selectionBox = root.querySelector('#vault-selection-box');

    resetView();

    root.addEventListener('mousedown', onPointerDown);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('dragover', e => e.preventDefault());
    root.addEventListener('drop', onDrop);
    if (minimapEl) minimapEl.addEventListener('mousedown', onMinimapClick);

    boundHandlers = { move: onPointerMove, up: onPointerUp, keydown: onKeyDown, keyup: onKeyUp };
    window.addEventListener('mousemove', boundHandlers.move);
    window.addEventListener('mouseup', boundHandlers.up);
    window.addEventListener('keydown', boundHandlers.keydown);
    window.addEventListener('keyup', boundHandlers.keyup);
  }

  function loadState(newState) {
    state = newState && newState.objects ? newState : { objects: {}, nextZ: 1 };
    undoStack.length = 0; redoStack.length = 0;
    selected.clear();
    render();
  }

  function getState() { return state; }

  return {
    init, destroy, loadState, getState,
    addObject, updateObject, deleteObjects,
    undo, redo, selectAll, clearSelection,
    setMode, zoomAt, resetView, panTo, jumpToObject,
    addImageAtCenter, addAudioAtCenter, addFrameAtCenter,
    getPinned, cardLabel, search, suggestConnections, autoLayoutGraph,
    cycleColor, togglePin,
    get viewport() { return viewport; },
  };
})();
