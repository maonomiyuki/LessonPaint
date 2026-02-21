const viewCanvas = document.getElementById('viewCanvas');
const viewCtx = viewCanvas.getContext('2d');
const canvasWrap = document.getElementById('canvasWrap');

const ui = {
  docWidth: document.getElementById('docWidth'),
  docHeight: document.getElementById('docHeight'),
  newDocBtn: document.getElementById('newDocBtn'),
  toolSelect: document.getElementById('toolSelect'),
  colorInput: document.getElementById('colorInput'),
  sizeInput: document.getElementById('sizeInput'),
  alphaInput: document.getElementById('alphaInput'),
  mouseDrawToggle: document.getElementById('mouseDrawToggle'),
  undoBtn: document.getElementById('undoBtn'),
  redoBtn: document.getElementById('redoBtn'),
  confirmShapeBtn: document.getElementById('confirmShapeBtn'),
  clearSelectionBtn: document.getElementById('clearSelectionBtn'),
  importInput: document.getElementById('importInput'),
  exportBtn: document.getElementById('exportBtn'),
  addLayerBtn: document.getElementById('addLayerBtn'),
  deleteLayerBtn: document.getElementById('deleteLayerBtn'),
  layerOpacity: document.getElementById('layerOpacity'),
  layerBlend: document.getElementById('layerBlend'),
  layerList: document.getElementById('layerList'),
};

const state = {
  doc: { width: 1024, height: 768 },
  view: { zoom: 1, panX: 0, panY: 0 },
  tool: 'pen',
  color: '#000000',
  size: 8,
  alpha: 1,
  allowMouseDraw: true,
  layers: [],
  activeLayerId: null,
  selection: { active: false, rect: null, moving: false, offset: { dx: 0, dy: 0 }, mode: 'replace' },
  interaction: {
    drawing: false,
    pointerId: null,
    lastDocPos: null,
    shapeDraft: null,
    polygonPoints: [],
    panPointers: new Map(),
    selectionDragStart: null,
    movingBuffer: null,
    movingStartRect: null,
  },
};

class HistoryManager {
  constructor(limit = 40) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  begin(label, captureTargets = {}) {
    if (this.pending) return;
    this.pending = {
      type: label,
      timestamp: Date.now(),
      payload: {
        affectedLayerIds: [...(captureTargets.layerIds || [])],
        before: new Map(),
        after: new Map(),
        layerMetaBefore: captureTargets.includeMeta ? deepCopyLayerMeta() : null,
        layerMetaAfter: null,
        selectionBefore: captureTargets.includeSelection ? deepCopy(state.selection) : null,
        selectionAfter: null,
      },
      captureTargets,
    };
    for (const id of this.pending.payload.affectedLayerIds) this.pending.payload.before.set(id, captureLayerImageData(id));
  }
  commit(label = null) {
    if (!this.pending) return;
    const entry = this.pending;
    if (label) entry.type = label;
    for (const id of entry.payload.affectedLayerIds) entry.payload.after.set(id, captureLayerImageData(id));
    if (entry.captureTargets.includeMeta) entry.payload.layerMetaAfter = deepCopyLayerMeta();
    if (entry.captureTargets.includeSelection) entry.payload.selectionAfter = deepCopy(state.selection);
    this.pending = null;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    syncUndoRedoUI();
  }
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    applyHistoryState(entry.payload.before, entry.payload.layerMetaBefore, entry.payload.selectionBefore);
    this.redoStack.push(entry);
    syncUndoRedoUI();
  }
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    applyHistoryState(entry.payload.after, entry.payload.layerMetaAfter, entry.payload.selectionAfter);
    this.undoStack.push(entry);
    syncUndoRedoUI();
  }
}

const history = new HistoryManager();

function createLayer(name = `Layer ${state.layers.length + 1}`) {
  const canvas = document.createElement('canvas');
  canvas.width = state.doc.width;
  canvas.height = state.doc.height;
  return { id: crypto.randomUUID(), name, canvas, visible: true, opacity: 1, blendMode: 'source-over' };
}

function getActiveLayer() {
  return state.layers.find((l) => l.id === state.activeLayerId);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepCopyLayerMeta() {
  return state.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode }));
}

function captureLayerImageData(layerId) {
  const layer = state.layers.find((l) => l.id === layerId);
  if (!layer) return null;
  const ctx = layer.canvas.getContext('2d');
  return ctx.getImageData(0, 0, state.doc.width, state.doc.height);
}

function applyHistoryState(layerMap, layerMeta, selection) {
  for (const [id, imageData] of layerMap.entries()) {
    const layer = state.layers.find((l) => l.id === id);
    if (!layer || !imageData) continue;
    const ctx = layer.canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
  }
  if (layerMeta) {
    const byId = new Map(state.layers.map((l) => [l.id, l]));
    state.layers = layerMeta.map((meta) => {
      const layer = byId.get(meta.id) || createLayer(meta.name);
      layer.id = meta.id;
      layer.name = meta.name;
      layer.visible = meta.visible;
      layer.opacity = meta.opacity;
      layer.blendMode = meta.blendMode;
      return layer;
    });
    if (!state.layers.find((l) => l.id === state.activeLayerId)) state.activeLayerId = state.layers.at(-1)?.id || null;
  }
  if (selection) state.selection = deepCopy(selection);
  renderLayerUI();
  render();
}

function resizeViewCanvas() {
  viewCanvas.width = canvasWrap.clientWidth;
  viewCanvas.height = canvasWrap.clientHeight;
  render();
}

function docToScreen({ x, y }) {
  return { x: x * state.view.zoom + state.view.panX, y: y * state.view.zoom + state.view.panY };
}

function screenToDoc({ x, y }) {
  return { x: (x - state.view.panX) / state.view.zoom, y: (y - state.view.panY) / state.view.zoom };
}

function render() {
  viewCtx.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
  viewCtx.save();
  viewCtx.setTransform(state.view.zoom, 0, 0, state.view.zoom, state.view.panX, state.view.panY);
  viewCtx.fillStyle = '#fff';
  viewCtx.fillRect(0, 0, state.doc.width, state.doc.height);
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    viewCtx.globalAlpha = layer.opacity;
    viewCtx.globalCompositeOperation = layer.blendMode;
    viewCtx.drawImage(layer.canvas, 0, 0);
  }
  viewCtx.globalAlpha = 1;
  viewCtx.globalCompositeOperation = 'source-over';

  if (state.interaction.movingBuffer && state.selection.active) {
    const { rect } = state.interaction.movingStartRect;
    const x = rect.x + state.selection.offset.dx;
    const y = rect.y + state.selection.offset.dy;
    viewCtx.drawImage(state.interaction.movingBuffer, x, y);
  }

  const d = state.interaction.shapeDraft;
  if (d) {
    viewCtx.strokeStyle = state.color;
    viewCtx.lineWidth = Math.max(1, state.size / 2);
    viewCtx.beginPath();
    if (d.type === 'line') {
      viewCtx.moveTo(d.start.x, d.start.y); viewCtx.lineTo(d.end.x, d.end.y);
    } else if (d.type === 'rect') {
      viewCtx.strokeRect(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
    } else if (d.type === 'circle') {
      viewCtx.ellipse(d.cx, d.cy, Math.abs(d.rx), Math.abs(d.ry), 0, 0, Math.PI * 2);
    } else if (d.type === 'polygon') {
      const pts = state.interaction.polygonPoints;
      if (pts.length > 1) {
        viewCtx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach((p) => viewCtx.lineTo(p.x, p.y));
      }
    }
    viewCtx.stroke();
  }

  if (state.selection.active && state.selection.rect) {
    const r = currentSelectionRect();
    viewCtx.strokeStyle = '#00d3ff';
    viewCtx.lineWidth = 1 / state.view.zoom;
    viewCtx.setLineDash([6 / state.view.zoom, 4 / state.view.zoom]);
    viewCtx.strokeRect(r.x, r.y, r.w, r.h);
    viewCtx.setLineDash([]);
  }
  viewCtx.restore();
}

function currentSelectionRect() {
  if (!state.selection.active || !state.selection.rect) return null;
  return {
    x: state.selection.rect.x + state.selection.offset.dx,
    y: state.selection.rect.y + state.selection.offset.dy,
    w: state.selection.rect.w,
    h: state.selection.rect.h,
  };
}

function clampRect(rect) {
  const x = Math.max(0, Math.min(state.doc.width, rect.x));
  const y = Math.max(0, Math.min(state.doc.height, rect.y));
  const x2 = Math.max(0, Math.min(state.doc.width, rect.x + rect.w));
  const y2 = Math.max(0, Math.min(state.doc.height, rect.y + rect.h));
  return { x: Math.min(x, x2), y: Math.min(y, y2), w: Math.abs(x2 - x), h: Math.abs(y2 - y) };
}

function pointerAllowedForDraw(e) {
  if (e.pointerType === 'pen') return true;
  if (e.pointerType === 'touch') return false;
  return state.allowMouseDraw;
}

function startStroke(docPos, e) {
  if (!pointerAllowedForDraw(e)) return;
  const layer = getActiveLayer();
  if (!layer) return;
  history.begin('stroke', { layerIds: [layer.id] });
  state.interaction.drawing = true;
  state.interaction.pointerId = e.pointerId;
  state.interaction.lastDocPos = docPos;
  const ctx = layer.canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = state.color;
  ctx.globalAlpha = state.alpha;
  ctx.lineWidth = state.size * (e.pressure || 1);
  ctx.globalCompositeOperation = state.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.beginPath();
  ctx.moveTo(docPos.x, docPos.y);
  ctx.lineTo(docPos.x + 0.01, docPos.y + 0.01);
  ctx.stroke();
  render();
}

function moveStroke(docPos, e) {
  const layer = getActiveLayer();
  if (!layer || !state.interaction.drawing) return;
  const ctx = layer.canvas.getContext('2d');
  if (state.tool === 'airbrush') {
    sprayAt(ctx, docPos, state.size, state.color, state.alpha, e.pressure || 0.5);
  } else {
    ctx.lineWidth = Math.max(1, state.size * (e.pressure || 1));
    ctx.beginPath();
    ctx.moveTo(state.interaction.lastDocPos.x, state.interaction.lastDocPos.y);
    ctx.lineTo(docPos.x, docPos.y);
    ctx.stroke();
  }
  state.interaction.lastDocPos = docPos;
  render();
}

function endStroke() {
  if (!state.interaction.drawing) return;
  state.interaction.drawing = false;
  state.interaction.pointerId = null;
  history.commit('stroke');
}

function sprayAt(ctx, pos, size, color, alpha, pressure) {
  const dots = Math.floor(20 * pressure);
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.2;
  for (let i = 0; i < dots; i++) {
    const r = Math.random() * (size / 2);
    const a = Math.random() * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r, Math.random() * 2 + 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function floodFill(layer, x, y, fillStyle) {
  const ctx = layer.canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, state.doc.width, state.doc.height);
  const data = image.data;
  const w = image.width;
  const h = image.height;
  const i = (Math.floor(y) * w + Math.floor(x)) * 4;
  const target = [data[i], data[i + 1], data[i + 2], data[i + 3]];
  const fill = hexToRgba(fillStyle, Math.floor(state.alpha * 255));
  if (target.every((v, idx) => v === fill[idx])) return;
  const stack = [[Math.floor(x), Math.floor(y)]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const idx = (cy * w + cx) * 4;
    if (data[idx] !== target[0] || data[idx + 1] !== target[1] || data[idx + 2] !== target[2] || data[idx + 3] !== target[3]) continue;
    data[idx] = fill[0]; data[idx + 1] = fill[1]; data[idx + 2] = fill[2]; data[idx + 3] = fill[3];
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  ctx.putImageData(image, 0, 0);
}

function hexToRgba(hex, alpha = 255) {
  const c = hex.replace('#', '');
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

function finishShape() {
  const d = state.interaction.shapeDraft;
  if (!d) return;
  const layer = getActiveLayer();
  if (!layer) return;
  history.begin('shape', { layerIds: [layer.id] });
  const ctx = layer.canvas.getContext('2d');
  ctx.strokeStyle = state.color;
  ctx.globalAlpha = state.alpha;
  ctx.lineWidth = state.size;
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  if (d.type === 'line') {
    ctx.moveTo(d.start.x, d.start.y); ctx.lineTo(d.end.x, d.end.y);
  } else if (d.type === 'rect') {
    ctx.strokeRect(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
  } else if (d.type === 'circle') {
    ctx.ellipse(d.cx, d.cy, Math.abs(d.rx), Math.abs(d.ry), 0, 0, Math.PI * 2);
  } else if (d.type === 'polygon') {
    const pts = state.interaction.polygonPoints;
    if (pts.length > 1) {
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
    }
  }
  ctx.stroke();
  state.interaction.shapeDraft = null;
  state.interaction.polygonPoints = [];
  history.commit('shape');
  render();
}

function clearSelection() {
  if (!state.selection.active) return;
  history.begin('selection-clear', { includeSelection: true, layerIds: [] });
  state.selection = { active: false, rect: null, moving: false, offset: { dx: 0, dy: 0 }, mode: 'replace' };
  history.commit('selection-clear');
  render();
}

function setSelectionRect(rect) {
  const clamped = clampRect(rect);
  if (clamped.w < 2 || clamped.h < 2) {
    state.selection.active = false;
    state.selection.rect = null;
  } else {
    state.selection.active = true;
    state.selection.rect = clamped;
    state.selection.offset = { dx: 0, dy: 0 };
  }
}

function startSelectionMove(docPos) {
  const rect = currentSelectionRect();
  if (!rect) return false;
  if (docPos.x < rect.x || docPos.y < rect.y || docPos.x > rect.x + rect.w || docPos.y > rect.y + rect.h) return false;
  const layer = getActiveLayer();
  if (!layer) return false;
  history.begin('selection-move', { layerIds: [layer.id], includeSelection: true });
  const buf = document.createElement('canvas');
  buf.width = rect.w;
  buf.height = rect.h;
  const lctx = layer.canvas.getContext('2d');
  buf.getContext('2d').drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  lctx.clearRect(rect.x, rect.y, rect.w, rect.h);
  state.interaction.movingBuffer = buf;
  state.interaction.movingStartRect = { rect: deepCopy(rect) };
  state.selection.moving = true;
  state.interaction.selectionDragStart = docPos;
  state.selection.offset = { dx: 0, dy: 0 };
  render();
  return true;
}

function moveSelection(docPos) {
  if (!state.selection.moving) return;
  const start = state.interaction.selectionDragStart;
  state.selection.offset = { dx: Math.round(docPos.x - start.x), dy: Math.round(docPos.y - start.y) };
  render();
}

function commitSelectionMove() {
  if (!state.selection.moving) return;
  const layer = getActiveLayer();
  const rect = state.interaction.movingStartRect.rect;
  const dx = state.selection.offset.dx;
  const dy = state.selection.offset.dy;
  layer.canvas.getContext('2d').drawImage(state.interaction.movingBuffer, rect.x + dx, rect.y + dy);
  state.selection.rect = { ...rect, x: rect.x + dx, y: rect.y + dy };
  state.selection.offset = { dx: 0, dy: 0 };
  state.selection.moving = false;
  state.interaction.movingBuffer = null;
  state.interaction.movingStartRect = null;
  history.commit('selection-move');
  render();
}

function onPointerDown(e) {
  e.preventDefault();
  viewCanvas.setPointerCapture(e.pointerId);
  const rect = viewCanvas.getBoundingClientRect();
  const docPos = screenToDoc({ x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (e.pointerType === 'touch') {
    state.interaction.panPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return;
  }

  if (state.tool === 'pen' || state.tool === 'eraser' || state.tool === 'airbrush') {
    startStroke(docPos, e);
  } else if (state.tool === 'fill') {
    const layer = getActiveLayer();
    if (!layer) return;
    history.begin('fill', { layerIds: [layer.id] });
    floodFill(layer, docPos.x, docPos.y, state.color);
    history.commit('fill');
    render();
  } else if (state.tool === 'line' || state.tool === 'rect' || state.tool === 'circle') {
    state.interaction.shapeDraft = { type: state.tool, start: docPos, end: docPos, rect: { x: docPos.x, y: docPos.y, w: 0, h: 0 }, cx: docPos.x, cy: docPos.y, rx: 0, ry: 0 };
  } else if (state.tool === 'polygon') {
    state.interaction.polygonPoints.push(docPos);
    state.interaction.shapeDraft = { type: 'polygon' };
  } else if (state.tool === 'select') {
    state.interaction.selectionDragStart = docPos;
    history.begin('selection-set', { includeSelection: true });
    setSelectionRect({ x: docPos.x, y: docPos.y, w: 0, h: 0 });
  } else if (state.tool === 'move') {
    if (!startSelectionMove(docPos)) {
      state.interaction.panPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  }
}

function onPointerMove(e) {
  e.preventDefault();
  const rect = viewCanvas.getBoundingClientRect();
  const docPos = screenToDoc({ x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (state.interaction.panPointers.has(e.pointerId)) {
    const prev = state.interaction.panPointers.get(e.pointerId);
    state.interaction.panPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.interaction.panPointers.size >= 2 || state.tool === 'move') {
      const all = [...state.interaction.panPointers.values()];
      if (all.length === 1) {
        state.view.panX += e.clientX - prev.x;
        state.view.panY += e.clientY - prev.y;
      } else {
        const [a, b] = all;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (!state.interaction.lastPinchDist) state.interaction.lastPinchDist = dist;
        const ratio = dist / state.interaction.lastPinchDist;
        state.view.zoom = Math.min(8, Math.max(0.1, state.view.zoom * ratio));
        state.interaction.lastPinchDist = dist;
      }
      render();
    }
    return;
  }

  if (state.interaction.drawing && state.interaction.pointerId === e.pointerId) moveStroke(docPos, e);

  if (state.interaction.shapeDraft && ['line', 'rect', 'circle'].includes(state.interaction.shapeDraft.type)) {
    const d = state.interaction.shapeDraft;
    d.end = docPos;
    if (d.type === 'rect') d.rect = { x: Math.min(d.start.x, docPos.x), y: Math.min(d.start.y, docPos.y), w: Math.abs(docPos.x - d.start.x), h: Math.abs(docPos.y - d.start.y) };
    if (d.type === 'circle') { d.cx = (d.start.x + docPos.x) / 2; d.cy = (d.start.y + docPos.y) / 2; d.rx = (docPos.x - d.start.x) / 2; d.ry = (docPos.y - d.start.y) / 2; }
    render();
  }

  if (state.tool === 'select' && state.interaction.selectionDragStart) {
    const s = state.interaction.selectionDragStart;
    setSelectionRect({ x: s.x, y: s.y, w: docPos.x - s.x, h: docPos.y - s.y });
    render();
  }

  if (state.selection.moving) moveSelection(docPos);
}

function onPointerUp(e) {
  e.preventDefault();
  const rect = viewCanvas.getBoundingClientRect();
  const docPos = screenToDoc({ x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (state.interaction.drawing && state.interaction.pointerId === e.pointerId) endStroke();

  if (state.tool === 'select' && state.interaction.selectionDragStart) {
    const s = state.interaction.selectionDragStart;
    setSelectionRect({ x: s.x, y: s.y, w: docPos.x - s.x, h: docPos.y - s.y });
    state.interaction.selectionDragStart = null;
    history.commit('selection-set');
    render();
  }

  if (state.selection.moving) commitSelectionMove();

  state.interaction.panPointers.delete(e.pointerId);
  if (state.interaction.panPointers.size < 2) state.interaction.lastPinchDist = null;
}

function renderLayerUI() {
  ui.layerList.innerHTML = '';
  const reversed = [...state.layers].reverse();
  reversed.forEach((layer, revIndex) => {
    const li = document.createElement('li');
    li.className = `layer-item ${layer.id === state.activeLayerId ? 'active' : ''}`;
    li.draggable = true;
    li.dataset.layerId = layer.id;
    li.innerHTML = `<input type="checkbox" ${layer.visible ? 'checked' : ''} data-role="visible"><span class="title">${layer.name}</span>`;
    li.addEventListener('click', () => { state.activeLayerId = layer.id; syncLayerMetaInputs(); renderLayerUI(); render(); });
    li.querySelector('[data-role="visible"]').addEventListener('change', (ev) => {
      history.begin('layer-visible', { includeMeta: true });
      layer.visible = ev.target.checked;
      history.commit('layer-visible');
      render();
    });
    li.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/layerId', layer.id));
    li.addEventListener('dragover', (ev) => ev.preventDefault());
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const fromId = ev.dataTransfer.getData('text/layerId');
      if (!fromId || fromId === layer.id) return;
      history.begin('layer-reorder', { includeMeta: true });
      const visualToDataIndex = (i) => state.layers.length - 1 - i;
      const toIndex = visualToDataIndex(revIndex);
      const fromIndex = state.layers.findIndex((l) => l.id === fromId);
      const [moved] = state.layers.splice(fromIndex, 1);
      state.layers.splice(toIndex, 0, moved);
      history.commit('layer-reorder');
      renderLayerUI();
      render();
    });
    ui.layerList.appendChild(li);
  });
  syncLayerMetaInputs();
}

function syncLayerMetaInputs() {
  const layer = getActiveLayer();
  if (!layer) return;
  ui.layerOpacity.value = layer.opacity;
  ui.layerBlend.value = layer.blendMode;
}

function syncUndoRedoUI() {
  ui.undoBtn.disabled = !history.canUndo;
  ui.redoBtn.disabled = !history.canRedo;
}

function addLayer(name) {
  history.begin('layer-add', { includeMeta: true });
  const layer = createLayer(name);
  state.layers.push(layer);
  state.activeLayerId = layer.id;
  history.commit('layer-add');
  renderLayerUI();
  render();
}

function deleteLayer() {
  if (state.layers.length <= 1) return;
  history.begin('layer-delete', { includeMeta: true });
  const idx = state.layers.findIndex((l) => l.id === state.activeLayerId);
  state.layers.splice(idx, 1);
  state.activeLayerId = state.layers[Math.max(0, idx - 1)].id;
  history.commit('layer-delete');
  renderLayerUI();
  render();
}

function newDocument(width, height) {
  state.doc.width = width;
  state.doc.height = height;
  state.layers = [];
  history.undoStack = [];
  history.redoStack = [];
  syncUndoRedoUI();
  const base = createLayer('Layer 1');
  state.layers.push(base);
  state.activeLayerId = base.id;
  state.selection = { active: false, rect: null, moving: false, offset: { dx: 0, dy: 0 }, mode: 'replace' };
  state.view = { zoom: 1, panX: 0, panY: 0 };
  renderLayerUI();
  render();
}

async function importImage(file) {
  const bmp = await createImageBitmap(file);
  history.begin('import-layer', { includeMeta: true, layerIds: [] });
  const layer = createLayer(file.name);
  layer.canvas.getContext('2d').drawImage(bmp, 0, 0);
  state.layers.push(layer);
  state.activeLayerId = layer.id;
  history.commit('import-layer');
  renderLayerUI();
  render();
}

function exportPng() {
  const out = document.createElement('canvas');
  out.width = state.doc.width;
  out.height = state.doc.height;
  const ctx = out.getContext('2d');
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blendMode;
    ctx.drawImage(layer.canvas, 0, 0);
  }
  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lessonpaint.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

ui.newDocBtn.addEventListener('click', () => newDocument(Number(ui.docWidth.value), Number(ui.docHeight.value)));
ui.toolSelect.addEventListener('change', () => { state.tool = ui.toolSelect.value; });
ui.colorInput.addEventListener('input', () => { state.color = ui.colorInput.value; });
ui.sizeInput.addEventListener('input', () => { state.size = Number(ui.sizeInput.value); });
ui.alphaInput.addEventListener('input', () => { state.alpha = Number(ui.alphaInput.value); });
ui.mouseDrawToggle.addEventListener('change', () => { state.allowMouseDraw = ui.mouseDrawToggle.checked; });
ui.undoBtn.addEventListener('click', () => history.undo());
ui.redoBtn.addEventListener('click', () => history.redo());
ui.confirmShapeBtn.addEventListener('click', finishShape);
ui.clearSelectionBtn.addEventListener('click', clearSelection);
ui.addLayerBtn.addEventListener('click', () => addLayer());
ui.deleteLayerBtn.addEventListener('click', deleteLayer);
ui.layerOpacity.addEventListener('pointerdown', () => history.begin('layer-opacity', { includeMeta: true }));
ui.layerOpacity.addEventListener('change', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  layer.opacity = Number(ui.layerOpacity.value);
  history.commit('layer-opacity');
  renderLayerUI();
  render();
});
ui.layerBlend.addEventListener('change', () => {
  const layer = getActiveLayer();
  if (!layer) return;
  history.begin('layer-blend', { includeMeta: true });
  layer.blendMode = ui.layerBlend.value;
  history.commit('layer-blend');
  renderLayerUI();
  render();
});
ui.importInput.addEventListener('change', (e) => { if (e.target.files[0]) importImage(e.target.files[0]); });
ui.exportBtn.addEventListener('click', exportPng);

window.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
  if (meta && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); history.redo(); }
  if (e.key === 'Enter') finishShape();
  if (e.key === 'Escape') clearSelection();
});

viewCanvas.addEventListener('pointerdown', onPointerDown);
viewCanvas.addEventListener('pointermove', onPointerMove);
viewCanvas.addEventListener('pointerup', onPointerUp);
viewCanvas.addEventListener('pointercancel', onPointerUp);
window.addEventListener('resize', resizeViewCanvas);

new ResizeObserver(resizeViewCanvas).observe(canvasWrap);
newDocument(1024, 768);
