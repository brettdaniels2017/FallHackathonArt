// SANDSCAPE — standalone sand-drawing toy. Not part of the eight-challenges site.
// Physics is Matter.js. This file only draws; it does not move grains by hand.

const COLORS = [
  { name: 'Warm yellow', hex: '#e2b043' },
  { name: 'Orange', hex: '#f08a24' },
  { name: 'Red', hex: '#e23d3d' },
  { name: 'Pink', hex: '#f47ba7' },
  { name: 'Purple', hex: '#7c5cbf' },
  { name: 'Blue', hex: '#3a78d8' },
  { name: 'Teal', hex: '#1fa7a0' },
  { name: 'Green', hex: '#3e9b56' },
  { name: 'White', hex: '#fffdf8' },
];

const WALL = 72;
const FILL_LINE = 28;
// Larger grains cover the same color with far fewer bodies, which keeps
// a full glass from stalling the page.
const GRAIN_MIN = 12;
const GRAIN_EXTRA = 2;
const MEAN_SIDE = GRAIN_MIN + GRAIN_EXTRA / 2;
const COLOR_PER_GRAIN = (Math.PI * 16) / (MEAN_SIDE * MEAN_SIDE);
const BACKSTOP = 120;
const DEFAULTS = { flow: 55, brush: 22, color: COLORS[0].hex, shape: 'cube', glass: 'box' };
const GLASSES = ['box', 'bowl', 'triangle', 'vase'];

const { Engine, Composite, Bodies, Body, Query, Resolver } = Matter;
// Default contact push. Cubes are separated exactly afterwards so a pile
// cannot crush them. Balls stay on this solver so they can roll and settle.
Resolver._positionDampen = 0.9;

const app = document.getElementById('app');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const paletteEl = document.getElementById('palette');
const customLabel = document.getElementById('custom-label');
const customInput = document.getElementById('custom-color');
const randomBtn = document.getElementById('random-btn');
const ballBtn = document.getElementById('shape-ball');
const cubeBtn = document.getElementById('shape-cube');
const glassButtons = Object.fromEntries(GLASSES.map((id) => [id, document.getElementById(`glass-${id}`)]));
const flowInput = document.getElementById('flow');
const brushInput = document.getElementById('brush');
const flowOut = document.getElementById('flow-out');
const brushOut = document.getElementById('brush-out');
const pauseBtn = document.getElementById('pause-btn');
const clearBtn = document.getElementById('clear-btn');
const resetBtn = document.getElementById('reset-btn');
const statusText = document.getElementById('status-text');

const engine = Engine.create({
  enableSleeping: true,
  // Two half-steps run each frame. Scale is raised so the fall speed
  // matches a single full step, while each step stays short enough
  // that grains cannot tunnel through the glass.
  gravity: { x: 0, y: 1, scale: 0.0024 },
});
engine.positionIterations = 16;
engine.velocityIterations = 8;

const world = engine.world;
let walls = [];
let grains = [];
let view = null;

let selected = DEFAULTS.color;
let randomMode = false;
let flow = DEFAULTS.flow;
let brush = DEFAULTS.brush;
let shape = DEFAULTS.shape;
let glass = DEFAULTS.glass;
let paused = false;
let pouring = false;
let pointer = null;
let hovering = false;
let emitAcc = 0;
let lastFrame = performance.now();

const swatchButtons = COLORS.map((color) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch';
  button.dataset.color = color.hex;
  button.style.setProperty('--swatch', color.hex);
  button.setAttribute('role', 'option');
  button.setAttribute('aria-label', color.name);
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => chooseColor(color.hex));
  paletteEl.append(button);
  return button;
});

function chooseColor(hex) {
  selected = hex;
  randomMode = false;
  customInput.value = toColorInput(hex);
  syncColorUI();
}

function toColorInput(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : DEFAULTS.color;
}

function syncColorUI() {
  const preset = COLORS.some((color) => color.hex === selected);
  for (const button of swatchButtons) {
    button.setAttribute('aria-pressed', String(!randomMode && button.dataset.color === selected));
  }
  customLabel.classList.toggle('is-on', !randomMode && !preset);
  randomBtn.setAttribute('aria-pressed', String(randomMode));
}

function fillLineY() {
  return view.inner.y + FILL_LINE;
}

function syncTransport() {
  pauseBtn.textContent = paused ? 'Play' : 'Pause';
  app.classList.toggle('is-paused', paused);
  statusText.textContent = paused ? 'Physics paused' : 'Physics active';
}

function syncShapeUI() {
  ballBtn.setAttribute('aria-pressed', String(shape === 'ball'));
  cubeBtn.setAttribute('aria-pressed', String(shape === 'cube'));
}

function syncGlassUI() {
  for (const id of GLASSES) {
    glassButtons[id].setAttribute('aria-pressed', String(glass === id));
  }
}

function chooseGlass(id) {
  if (glass === id) return;
  glass = id;
  clearSand();
  syncGlassUI();
  if (view) buildWalls();
}

// Inner left/right edges at a given y. Every vessel uses the same outer box,
// so the shapes stay a similar size and only the silhouette changes.
function glassSpan(y) {
  const box = view.inner;
  const top = box.y;
  const bottom = box.y + box.h;
  const cx = box.x + box.w / 2;
  const clamped = Math.min(Math.max(y, top), bottom);
  const t = (clamped - top) / box.h;
  let half = box.w / 2;
  if (glass === 'bowl') {
    const curve = Math.sqrt(Math.max(0, 1 - t * t));
    half = box.w * 0.18 + (box.w / 2 - box.w * 0.18) * curve;
  } else if (glass === 'triangle') {
    const floorHalf = box.w * 0.06;
    half = box.w / 2 - (box.w / 2 - floorHalf) * t;
  } else if (glass === 'vase') {
    half = (box.w / 2) * (1 - 0.52 * t);
  }
  return { left: cx - half, right: cx + half };
}

function slab(x1, y1, x2, y2, nx, ny, hidden) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;
  const ux = dx / len;
  const uy = dy / len;
  const extra = WALL * 0.45;
  const ax = x1 - ux * extra;
  const ay = y1 - uy * extra;
  const bx = x2 + ux * extra;
  const by = y2 + uy * extra;
  return Bodies.rectangle(
    (ax + bx) / 2 + nx * (WALL / 2),
    (ay + by) / 2 + ny * (WALL / 2),
    len + extra * 2,
    WALL,
    { ...hidden, angle: Math.atan2(uy, ux) },
  );
}

function edgeWalls(points, outwardSign, hidden) {
  const bodies = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nx = outwardSign === 1 ? -dy : dy;
    const ny = outwardSign === 1 ? dx : -dx;
    const nl = Math.hypot(nx, ny) || 1;
    const body = slab(a.x, a.y, b.x, b.y, nx / nl, ny / nl, hidden);
    if (body) bodies.push(body);
  }
  return bodies;
}

function shapeOutline(samples) {
  const box = view.inner;
  const left = [];
  const right = [];
  for (let i = 0; i <= samples; i++) {
    const y = box.y + (box.h * i) / samples;
    const span = glassSpan(y);
    left.push({ x: span.left, y });
    right.push({ x: span.right, y });
  }
  return { left, right };
}

function grainColor() {
  if (randomMode) return COLORS[(Math.random() * COLORS.length) | 0].hex;
  return selected;
}

function measure() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const marginX = Math.max(64, width * 0.16);
  const marginTop = Math.max(32, height * 0.07);
  const marginBottom = Math.max(40, height * 0.09);
  const innerW = Math.max(120, (width - marginX * 2) * 0.8);
  const innerH = Math.max(160, (height - marginTop - marginBottom) * 0.8);
  const spareY = height - marginTop - marginBottom - innerH;
  return {
    width,
    height,
    inner: {
      x: (width - innerW) / 2,
      y: marginTop + spareY / 2,
      w: innerW,
      h: innerH,
    },
  };
}

function buildWalls() {
  if (walls.length) Composite.remove(world, walls);
  const box = view.inner;
  const floorY = box.y + box.h;
  const lip = box.y - 8;
  const wallH = floorY + WALL - lip;
  const hidden = { isStatic: true, friction: 0.9, restitution: 0, slop: 0, label: 'wall' };
  const back = [
    Bodies.rectangle(box.x + box.w / 2, floorY + WALL + BACKSTOP / 2, box.w + BACKSTOP * 2, BACKSTOP, hidden),
    Bodies.rectangle(box.x - WALL - BACKSTOP / 2, lip + wallH / 2, BACKSTOP, wallH + BACKSTOP, hidden),
    Bodies.rectangle(box.x + box.w + WALL + BACKSTOP / 2, lip + wallH / 2, BACKSTOP, wallH + BACKSTOP, hidden),
  ];

  if (glass === 'box') {
    const floor = Bodies.rectangle(
      box.x + box.w / 2,
      floorY + WALL / 2,
      box.w + WALL * 2,
      WALL,
      { ...hidden, friction: 0.95 },
    );
    const left = Bodies.rectangle(box.x - WALL / 2, lip + wallH / 2, WALL, wallH, hidden);
    const right = Bodies.rectangle(box.x + box.w + WALL / 2, lip + wallH / 2, WALL, wallH, hidden);
    walls = [floor, left, right, ...back];
  } else {
    const outline = shapeOutline(36);
    const leftWalls = edgeWalls(outline.left, 1, hidden);
    const rightWalls = edgeWalls(outline.right, -1, hidden);
    const bl = outline.left[outline.left.length - 1];
    const br = outline.right[outline.right.length - 1];
    const floor = slab(bl.x, bl.y, br.x, br.y, 0, 1, { ...hidden, friction: 0.95 });
    walls = [...leftWalls, ...rightWalls, floor, ...back];
  }
  Composite.add(world, walls);
  containGrains();
}

function containGrains() {
  const box = view.inner;
  for (const body of grains) {
    const r = body.sandSize / 2;
    let y = body.position.y;
    const minY = fillLineY() + r;
    const maxY = box.y + box.h - r - 1;
    const escapedY = y < minY - 2 || y > maxY + 2;
    if (escapedY) y = Math.min(Math.max(y, minY), maxY);
    const span = glassSpan(y);
    const minX = span.left + r + 1;
    const maxX = span.right - r - 1;
    let x = body.position.x;
    const escapedX = maxX > minX && (x < minX - 2 || x > maxX + 2);
    if (escapedX) x = Math.min(Math.max(x, minX), maxX);
    if (x !== body.position.x || y !== body.position.y) {
      Body.setPosition(body, { x, y });
      Body.setVelocity(body, { x: 0, y: 0 });
    }
  }
}

function separateCubePair(a, b) {
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const reach = a.sandSize / 2 + b.sandSize / 2;
  const overlapX = reach - Math.abs(dx);
  const overlapY = reach - Math.abs(dy);
  if (overlapX <= 0 || overlapY <= 0) return;
  if (overlapX < overlapY) {
    const sign = dx < 0 ? -1 : 1;
    const shift = overlapX / 2;
    Body.setPosition(a, { x: a.position.x - sign * shift, y: a.position.y });
    Body.setPosition(b, { x: b.position.x + sign * shift, y: b.position.y });
    return;
  }
  const top = a.position.y <= b.position.y ? a : b;
  const bottom = top === a ? b : a;
  Body.setPosition(top, { x: top.position.x, y: bottom.position.y - reach });
}

function unstickCubes() {
  const cubes = [];
  for (const body of grains) {
    if (body.sandShape === 'cube') cubes.push(body);
  }
  if (cubes.length < 2) return;
  const cell = 20;
  for (let pass = 0; pass < 6; pass++) {
    const grid = new Map();
    for (const body of cubes) {
      const key = `${Math.floor(body.position.x / cell)},${Math.floor(body.position.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(body);
      else grid.set(key, [body]);
    }
    for (const body of cubes) {
      const gx = Math.floor(body.position.x / cell);
      const gy = Math.floor(body.position.y / cell);
      for (let ix = -1; ix <= 1; ix++) {
        for (let iy = -1; iy <= 1; iy++) {
          const bucket = grid.get(`${gx + ix},${gy + iy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id <= body.id) continue;
            separateCubePair(body, other);
          }
        }
      }
    }
  }
}

function resize() {
  const next = measure();
  if (next.width < 2 || next.height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelW = Math.round(next.width * dpr);
  const pixelH = Math.round(next.height * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const same = view
    && view.inner.x === next.inner.x
    && view.inner.y === next.inner.y
    && view.inner.w === next.inner.w
    && view.inner.h === next.inner.h;
  view = next;
  if (!same) buildWalls();
}

function overlaps(x, y, size, kind) {
  const half = size / 2;
  const found = Query.region(grains, {
    min: { x: x - half, y: y - half },
    max: { x: x + half, y: y + half },
  });
  for (const body of found) {
    const other = body.sandSize / 2;
    const dx = body.position.x - x;
    const dy = body.position.y - y;
    if (kind === 'ball' && body.sandShape === 'ball') {
      const reach = half + other + 0.2;
      if (dx * dx + dy * dy < reach * reach) return true;
    } else if (Math.abs(dx) < half + other + 0.35 && Math.abs(dy) < half + other + 0.35) {
      return true;
    }
  }
  return false;
}

function brushRadius() {
  return Math.max(4, brush / 2);
}

function pourOrigin() {
  if (!pointer || !view) return null;
  const box = view.inner;
  if (pointer.y < box.y - 24 || pointer.y > box.y + box.h) return null;
  const y = Math.min(Math.max(pointer.y, box.y), box.y + box.h - 1);
  const span = glassSpan(y);
  if (pointer.x < span.left || pointer.x > span.right) return null;
  return { x: pointer.x, y: pointer.y };
}

function spawnGrain(origin) {
  const size = GRAIN_MIN + Math.random() * GRAIN_EXTRA;
  const half = size / 2;
  const box = view.inner;
  const ceiling = fillLineY() + half + 0.5;
  // Keep the whole grain inside the ring, not just its center.
  const reach = Math.max(0, brushRadius() - half);
  let spot = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * reach;
    const cx = origin.x + Math.cos(angle) * dist;
    const cy = origin.y + Math.sin(angle) * dist;
    if (cy < ceiling || cy > box.y + box.h - half - 1) continue;
    const span = glassSpan(cy);
    if (cx < span.left + half + 1 || cx > span.right - half - 1) continue;
    if (!overlaps(cx, cy, size, shape)) {
      spot = { x: cx, y: cy };
      break;
    }
  }
  if (!spot) return;

  const grainOptions = {
    restitution: shape === 'cube' ? 0 : 0.05,
    friction: shape === 'cube' ? 0.96 : 0.35,
    frictionStatic: shape === 'cube' ? 1.2 : 0.45,
    frictionAir: 0.012,
    density: 0.002,
    slop: shape === 'cube' ? 0 : 0.05,
    sleepThreshold: 60,
    label: 'sand',
  };
  const body = shape === 'ball'
    ? Bodies.circle(spot.x, spot.y, size / 2, grainOptions)
    : Bodies.rectangle(spot.x, spot.y, size, size, grainOptions);
  body.sandColor = grainColor();
  body.sandSize = size;
  body.sandShape = shape;
  // Cubes stay square so a stack rests face to face instead of folding.
  if (shape === 'cube') Body.setInertia(body, Infinity);
  Composite.add(world, body);
  Body.setVelocity(body, { x: 0, y: 0 });
  grains.push(body);
}

function emit(dt) {
  if (!pouring || paused) return;
  const origin = pourOrigin();
  if (!origin) {
    emitAcc = 0;
    return;
  }
  emitAcc += dt;
  const interval = 1000 / (flow * COLOR_PER_GRAIN);
  let spawned = 0;
  while (emitAcc >= interval && spawned < 8) {
    emitAcc -= interval;
    spawnGrain(origin);
    spawned += 1;
  }
}

function clearSand() {
  if (!grains.length) return;
  Composite.remove(world, grains.slice());
  grains = [];
  emitAcc = 0;
}

function resetAll() {
  clearSand();
  paused = false;
  pouring = false;
  randomMode = false;
  selected = DEFAULTS.color;
  shape = DEFAULTS.shape;
  glass = DEFAULTS.glass;
  flow = DEFAULTS.flow;
  brush = DEFAULTS.brush;
  flowInput.value = String(flow);
  brushInput.value = String(brush);
  flowOut.textContent = String(flow);
  brushOut.textContent = String(brush);
  customInput.value = selected;
  syncColorUI();
  syncShapeUI();
  syncGlassUI();
  if (view) buildWalls();
  syncTransport();
}

function eventPoint(event) {
  const rect = canvas.getBoundingClientRect();
  if (!view || rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * view.width,
    y: ((event.clientY - rect.top) / rect.height) * view.height,
  };
}

function insideGlass(point) {
  if (!point || !view) return false;
  const box = view.inner;
  if (point.y < box.y - 24 || point.y > box.y + box.h) return false;
  const y = Math.min(Math.max(point.y, box.y), box.y + box.h - 1);
  const span = glassSpan(y);
  return point.x >= span.left && point.x <= span.right;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  pointer = eventPoint(event);
  hovering = insideGlass(pointer);
  if (!hovering) return;
  pouring = true;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (err) {
    // A synthetic pointer has no id to capture. Real pointers still capture.
  }
}

function onPointerMove(event) {
  pointer = eventPoint(event);
  hovering = insideGlass(pointer);
}

function stopPour() {
  pouring = false;
  emitAcc = 0;
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', stopPour);
canvas.addEventListener('pointercancel', stopPour);
window.addEventListener('pointerup', stopPour);

customInput.addEventListener('input', () => chooseColor(customInput.value));
randomBtn.addEventListener('click', () => {
  randomMode = !randomMode;
  syncColorUI();
});
ballBtn.addEventListener('click', () => {
  shape = 'ball';
  syncShapeUI();
});
cubeBtn.addEventListener('click', () => {
  shape = 'cube';
  syncShapeUI();
});
for (const id of GLASSES) {
  glassButtons[id].addEventListener('click', () => chooseGlass(id));
}
flowInput.addEventListener('input', () => {
  flow = Number(flowInput.value);
  flowOut.textContent = String(flow);
});
brushInput.addEventListener('input', () => {
  brush = Number(brushInput.value);
  brushOut.textContent = String(brush);
});
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  if (paused) emitAcc = 0;
  syncTransport();
});
clearBtn.addEventListener('click', () => {
  clearSand();
  syncTransport();
});
resetBtn.addEventListener('click', resetAll);

function roundPath(x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, [18, 18, 6, 6]);
  else ctx.rect(x, y, w, h);
}

function traceVessel(inset) {
  const box = view.inner;
  if (glass === 'box') {
    roundPath(box.x + inset, box.y + inset, box.w - inset * 2, box.h - inset * 2, Math.max(8, 20 - inset));
    return;
  }
  const steps = 64;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const y = box.y + inset + ((box.h - inset * 2) * i) / steps;
    const span = glassSpan(y);
    const x = span.left + inset;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = steps; i >= 0; i--) {
    const y = box.y + inset + ((box.h - inset * 2) * i) / steps;
    const span = glassSpan(y);
    ctx.lineTo(span.right - inset, y);
  }
  ctx.closePath();
}

function drawGlassBowl() {
  ctx.save();
  ctx.shadowColor = 'rgba(70, 52, 28, 0.14)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = 'rgba(255, 252, 247, 0.55)';
  traceVessel(0);
  ctx.fill();
  ctx.restore();
}

function drawGlassRim() {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 6;
  traceVessel(3);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(74, 78, 86, 0.55)';
  ctx.lineWidth = 3;
  traceVessel(0);
  ctx.stroke();
  ctx.restore();
}

function drawFillLine() {
  const y = fillLineY();
  const span = glassSpan(y);
  ctx.save();
  ctx.strokeStyle = 'rgba(74, 78, 86, 0.55)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(span.left + 14, y);
  ctx.lineTo(span.right - 14, y);
  ctx.stroke();
  ctx.restore();
}

function drawSand() {
  const groups = new Map();
  for (const body of grains) {
    const color = body.sandColor;
    let list = groups.get(color);
    if (!list) {
      list = [];
      groups.set(color, list);
    }
    list.push(body);
  }
  for (const [color, list] of groups) {
    ctx.beginPath();
    for (const body of list) {
      if (body.sandShape === 'ball') {
        ctx.moveTo(body.position.x + body.circleRadius, body.position.y);
        ctx.arc(body.position.x, body.position.y, body.circleRadius, 0, Math.PI * 2);
      } else {
        const v = body.vertices;
        ctx.moveTo(v[0].x, v[0].y);
        ctx.lineTo(v[1].x, v[1].y);
        ctx.lineTo(v[2].x, v[2].y);
        ctx.lineTo(v[3].x, v[3].y);
        ctx.closePath();
      }
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color === '#fffdf8' ? 'rgba(90, 78, 64, 0.35)' : 'rgba(42, 38, 34, 0.18)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
}

function drawEmptyCue() {
  if (grains.length) return;
  const box = view.inner;
  ctx.save();
  ctx.fillStyle = 'rgba(42, 38, 34, 0.46)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px Inter, system-ui, sans-serif';
  ctx.fillText('CLICK + HOLD TO POUR', box.x + box.w / 2, box.y + box.h * 0.46);
  ctx.font = '500 12px Inter, system-ui, sans-serif';
  ctx.fillText('CHANGE COLORS TO CREATE YOUR ART', box.x + box.w / 2, box.y + box.h * 0.46 + 22);
  ctx.restore();
}

function drawBrush() {
  if (!hovering || !pointer || paused) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, brushRadius(), 0, Math.PI * 2);
  ctx.strokeStyle = randomMode ? 'rgba(42, 38, 34, 0.45)' : selected;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = '#f3efe6';
  ctx.fillRect(0, 0, view.width, view.height);
  drawGlassBowl();
  drawSand();
  drawFillLine();
  drawGlassRim();
  drawEmptyCue();
  drawBrush();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(34, now - lastFrame);
  lastFrame = now;
  if (!paused) {
    Engine.update(engine, 1000 / 120);
    Engine.update(engine, 1000 / 120);
    containGrains();
    unstickCubes();
    emit(dt);
  }
  if (view) {
    draw();
    syncTransport();
  }
}

syncColorUI();
syncShapeUI();
syncGlassUI();
syncTransport();
resize();
new ResizeObserver(resize).observe(document.getElementById('stage'));
requestAnimationFrame(frame);
