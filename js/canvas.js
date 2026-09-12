/**
 * Vault.Canvas
 * -------------------------------------------------------------
 * A dependency-free infinite canvas engine. Objects are plain
 * DOM nodes positioned inside a single transformed "world" div
 * (translate + scale), so pan/zoom is one CSS transform and every
 * card gets native text editing, image rendering, etc. for free.
 *
 * Data model (kept deliberately flat & extensible):
 *   { id, type, x, y, w, h, z, createdAt, updatedAt, data }
 *   type ∈ 'text' | 'image' | 'drawing' | 'link' | 'arrow'
 *   arrow objects don't use x/y/w/h; their data holds {fromId,toId}
 * -------------------------------------------------------------
 */
const VaultCanvas = (() => {
  let root, world, svgLayer, objectLayer, selectionBox;
  let state = { objects: {}, nextZ: 1 };
  let selected = new Set();
  let viewport = { x: 0, y: 0, scale: 1 };
  let onChange = () => {};

  // ---- history (undo/redo) ----
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 100;
  let suppressHistory = false;

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

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

  function notifyChange() {
    onChange(state);
  }

  // ---- coordinate helpers ----
  function screenToWorld(sx, sy) {
    const rect = root.getBoundingClientRect();
    return {
      x: (sx - rect.left - viewport.x) / viewport.scale,
      y: (sy - rect.top - viewport.y) / viewport.scale,
    };
  }

  function applyViewportTransform() {
    world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = root.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const newScale = Math.min(3, Math.max(0.15, viewport.scale * factor));
    // keep the point under the cursor fixed
    viewport.x = cx - ((cx - viewport.x) / viewport.scale) * newScale;
    viewport.y = cy - ((cy - viewport.y) / viewport.scale) * newScale;
    viewport.scale = newScale;
    applyViewportTransform();
  }

  function resetView() {
    viewport = { x: root.clientWidth / 2, y: root.clientHeight / 2, scale: 1 };
    applyViewportTransform();
  }

  // ---- object CRUD ----
  function genId() {
    return 'o_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function addObject(partial, { record = true } = {}) {
    if (record) pushHistory();
    const now = Date.now();
    const obj = {
      id: genId(),
      x: 0, y: 0, w: 220, h: 120, z: state.nextZ++,
      createdAt: now, updatedAt: now,
      data: {},
      ...partial,
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
    Object.assign(obj, patch, { updatedAt: Date.now() });
    render();
    notifyChange();
  }

  function deleteObjects(ids) {
    if (!ids.length) return;
    pushHistory();
    const idSet = new Set(ids);
    for (const id of ids) delete state.objects[id];
    // also delete arrows attached to any deleted node
    for (const [oid, o] of Object.entries(state.objects)) {
      if (o.type === 'arrow' && (idSet.has(o.data.fromId) || idSet.has(o.data.toId))) {
        delete state.objects[oid];
      }
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

  // ---- selection ----
  function clearSelection() {
    selected.clear();
    render();
  }

  function selectAll() {
    selected = new Set(Object.keys(state.objects).filter(id => state.objects[id].type !== 'arrow'));
    render();
  }

  // ---- rendering ----
  function render() {
    objectLayer.innerHTML = '';
    svgLayer.innerHTML = '';
    const objs = Object.values(state.objects).sort((a, b) => a.z - b.z);

    // arrows first (so they sit under cards visually is fine either way; draw after for visibility)
    for (const obj of objs) {
      if (obj.type === 'arrow') renderArrow(obj);
      else renderCard(obj);
    }
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

  function renderCard(obj) {
    const el = document.createElement('div');
    el.className = `vault-card vault-${obj.type}` + (selected.has(obj.id) ? ' selected' : '');
    el.style.left = obj.x + 'px';
    el.style.top = obj.y + 'px';
    el.style.width = obj.w + 'px';
    el.style.height = obj.h + 'px';
    el.style.zIndex = obj.z;
    el.dataset.id = obj.id;

    if (obj.type === 'text') {
      el.innerHTML = `
        <div class="card-head" data-role="drag">
          <input class="card-title" placeholder="Title (optional)" value="${escapeAttr(obj.data.title || '')}"/>
        </div>
        <textarea class="card-body" placeholder="Write anything...">${escapeHtml(obj.data.body || '')}</textarea>
      `;
      const titleInput = el.querySelector('.card-title');
      const bodyArea = el.querySelector('.card-body');
      titleInput.addEventListener('change', () => updateObject(obj.id, { data: { ...obj.data, title: titleInput.value } }));
      bodyArea.addEventListener('blur', () => updateObject(obj.id, { data: { ...obj.data, body: bodyArea.value } }));
      bodyArea.addEventListener('mousedown', e => e.stopPropagation());
      titleInput.addEventListener('mousedown', e => e.stopPropagation());
    } else if (obj.type === 'image') {
      el.innerHTML = `<div class="card-head" data-role="drag"></div><img src="${obj.data.src}" class="card-img" draggable="false"/>`;
    } else if (obj.type === 'link') {
      el.innerHTML = `
        <div class="card-head" data-role="drag">🔗</div>
        <a href="${escapeAttr(obj.data.url || '#')}" target="_blank" rel="noopener noreferrer" class="card-link">${escapeHtml(obj.data.url || '')}</a>
      `;
      el.querySelector('a').addEventListener('mousedown', e => e.stopPropagation());
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

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);

    objectLayer.appendChild(el);
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // ---- interaction state ----
  let mode = 'select'; // 'select' | 'draw' | 'connect'
  let spaceHeld = false;
  let drag = null; // {type:'pan'|'move'|'resize'|'rubberband'|'draw', ...}
  let connectFromId = null;

  function setMode(m) {
    mode = m;
    connectFromId = null;
    root.classList.toggle('mode-draw', m === 'draw');
    root.classList.toggle('mode-connect', m === 'connect');
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    const targetCard = e.target.closest('.vault-card');
    const onHandle = e.target.classList.contains('resize-handle');

    if (spaceHeld) {
      drag = { type: 'pan', startX: e.clientX, startY: e.clientY, ox: viewport.x, oy: viewport.y };
      return;
    }

    if (mode === 'draw') {
      drag = { type: 'draw', points: [worldPos], startScreen: { x: e.clientX, y: e.clientY } };
      return;
    }

    if (mode === 'connect') {
      if (targetCard) {
        const id = targetCard.dataset.id;
        if (!connectFromId) {
          connectFromId = id;
        } else if (connectFromId !== id) {
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
      if (!selected.has(id)) {
        if (!e.shiftKey) selected.clear();
        selected.add(id);
      }
      bringToFront(id);
      pushHistory();
      const obj = state.objects[id];
      drag = {
        type: 'move', startX: e.clientX, startY: e.clientY, scale: viewport.scale,
        origins: [...selected].map(sid => ({ id: sid, x: state.objects[sid].x, y: state.objects[sid].y })),
      };
      render();
      return;
    }

    // empty canvas
    if (!e.shiftKey) { selected.clear(); render(); }
    drag = { type: 'pending-rubberband', startScreen: { x: e.clientX, y: e.clientY }, worldStart: worldPos, moved: false };
  }

  function onPointerMove(e) {
    if (!drag) return;

    if (drag.type === 'pan') {
      viewport.x = drag.ox + (e.clientX - drag.startX);
      viewport.y = drag.oy + (e.clientY - drag.startY);
      applyViewportTransform();
      return;
    }

    if (drag.type === 'draw') {
      drag.points.push(screenToWorld(e.clientX, e.clientY));
      drawLivePath(drag.points);
      return;
    }

    if (drag.type === 'move') {
      const dx = (e.clientX - drag.startX) / drag.scale;
      const dy = (e.clientY - drag.startY) / drag.scale;
      for (const o of drag.origins) {
        state.objects[o.id].x = o.x + dx;
        state.objects[o.id].y = o.y + dy;
      }
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
      if (distMoved > 4) {
        drag.type = 'rubberband';
        drag.moved = true;
        selectionBox.style.display = 'block';
      } else {
        return;
      }
    }

    if (drag.type === 'rubberband') {
      const cur = screenToWorld(e.clientX, e.clientY);
      const x1 = Math.min(drag.worldStart.x, cur.x), x2 = Math.max(drag.worldStart.x, cur.x);
      const y1 = Math.min(drag.worldStart.y, cur.y), y2 = Math.max(drag.worldStart.y, cur.y);
      const rect = root.getBoundingClientRect();
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
    // preview handled by re-rendering a temp path in the svg layer
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

  function onPointerUp(e) {
    if (!drag) return;

    if (drag.type === 'draw') {
      const pts = drag.points;
      const live = svgLayer.querySelector('#live-draw-path');
      if (live) live.remove();
      if (pts.length > 1) {
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const maxX = Math.max(...xs), maxY = Math.max(...ys);
        const w = Math.max(20, maxX - minX), h = Math.max(20, maxY - minY);
        const relPath = pointsToPath(pts.map(p => ({ x: p.x - minX, y: p.y - minY })));
        addObject({ type: 'drawing', x: minX, y: minY, w, h, data: { path: relPath } });
      }
    }

    if (drag.type === 'rubberband') {
      selectionBox.style.display = 'none';
    }

    drag = null;
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // pinch-zoom gesture (trackpad) or ctrl+scroll (mouse)
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomAt(e.clientX, e.clientY, factor);
    } else {
      // two-finger trackpad scroll / mouse wheel => pan
      viewport.x -= e.deltaX;
      viewport.y -= e.deltaY;
      applyViewportTransform();
    }
  }

  function onDblClick(e) {
    if (e.target.closest('.vault-card')) return;
    if (mode !== 'select') return;
    const pos = screenToWorld(e.clientX, e.clientY);
    const obj = addObject({ type: 'text', x: pos.x - 110, y: pos.y - 60, w: 220, h: 120, data: { title: '', body: '' } });
    requestAnimationFrame(() => {
      const el = objectLayer.querySelector(`[data-id="${obj.id}"] .card-body`);
      if (el) el.focus();
    });
  }

  function onKeyDown(e) {
    const activeTag = document.activeElement && document.activeElement.tagName;
    const typing = activeTag === 'TEXTAREA' || activeTag === 'INPUT';

    if (e.code === 'Space' && !typing) { spaceHeld = true; root.classList.add('space-pan'); e.preventDefault(); }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing) {
      e.preventDefault();
      selectAll();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selected.size) {
      e.preventDefault();
      deleteObjects([...selected]);
      return;
    }
    if (e.key === 'Escape') {
      selected.clear();
      connectFromId = null;
      setMode('select');
      render();
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') { spaceHeld = false; root.classList.remove('space-pan'); }
  }

  function addImageAtCenter(dataUrl, atWorldPos) {
    const img = new Image();
    img.onload = () => {
      const maxDim = 320;
      const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = img.width * ratio || 200;
      const h = img.height * ratio || 200;
      const pos = atWorldPos || screenToWorld(root.clientWidth / 2 + root.getBoundingClientRect().left, root.clientHeight / 2 + root.getBoundingClientRect().top);
      addObject({ type: 'image', x: pos.x - w / 2, y: pos.y - h / 2, w, h, data: { src: dataUrl } });
    };
    img.src = dataUrl;
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
    destroy(); // ensure no leftover listeners from a previous session
    root = container;
    onChange = opts.onChange || (() => {});
    root.innerHTML = `
      <div class="vault-world" id="vault-world">
        <svg class="vault-svg-layer" id="vault-svg-layer">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z" class="arrowhead-fill" />
            </marker>
          </defs>
        </svg>
        <div class="vault-object-layer" id="vault-object-layer"></div>
      </div>
      <div class="vault-selection-box" id="vault-selection-box"></div>
    `;
    world = root.querySelector('#vault-world');
    svgLayer = root.querySelector('#vault-svg-layer');
    objectLayer = root.querySelector('#vault-object-layer');
    selectionBox = root.querySelector('#vault-selection-box');

    resetView();

    root.addEventListener('mousedown', onPointerDown);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('dragover', e => e.preventDefault());
    root.addEventListener('drop', onDrop);

    boundHandlers = { move: onPointerMove, up: onPointerUp, keydown: onKeyDown, keyup: onKeyUp };
    window.addEventListener('mousemove', boundHandlers.move);
    window.addEventListener('mouseup', boundHandlers.up);
    window.addEventListener('keydown', boundHandlers.keydown);
    window.addEventListener('keyup', boundHandlers.keyup);
  }

  function loadState(newState) {
    state = newState && newState.objects ? newState : { objects: {}, nextZ: 1 };
    undoStack.length = 0;
    redoStack.length = 0;
    selected.clear();
    render();
  }

  function getState() {
    return state;
  }

  return {
    init, destroy, loadState, getState,
    addObject, updateObject, deleteObjects,
    undo, redo, selectAll, clearSelection,
    setMode, zoomAt, resetView,
    get viewport() { return viewport; },
    addImageAtCenter,
  };
})();
