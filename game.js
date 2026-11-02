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
// Cubes are a step up from the dust-sized grains, close to the first
// grains in painted area, so the stream stays full without thousands of bodies.
const GRAIN_MIN = 6;
const GRAIN_EXTRA = 1;
const MEAN_SIDE = GRAIN_MIN + GRAIN_EXTRA / 2;
const COLOR_PER_GRAIN = (Math.PI * 16) / (MEAN_SIDE * MEAN_SIDE);
const BACKSTOP = 120;
const DEFAULTS = { flow: 55, brush: 22, color: COLORS[0].hex, shape: 'cube' };

const { Engine, Composite, Bodies, Body, Query, Resolver } = Matter;
// A little more of each contact is pushed back out, so a tall pile
// sinks less where the weight is greatest.
Resolver._positionDampen = 1.28;

const app = document.getElementById('app');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const paletteEl = document.getElementById('palette');
const customLabel = document.getElementById('custom-label');
const customInput = document.getElementById('custom-color');
const randomBtn = document.getElementById('random-btn');
const ballBtn = document.getElementById('shape-ball');
const cubeBtn = document.getElementById('shape-cube');
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

function grainColor() {
  if (randomMode) return COLORS[(Math.random() * COLORS.length) | 0].hex;
  return selected;
}

function measure() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const marginX = Math.max(28, width * 0.06);
  const marginTop = 18;
  const marginBottom = 26;
  const innerW = Math.max(120, width - marginX * 2);
  const innerH = Math.max(160, height - marginTop - marginBottom);
  return {
    width,
    height,
    inner: {
      x: (width - innerW) / 2,
      y: marginTop,
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

  const floor = Bodies.rectangle(
    box.x + box.w / 2,
    floorY + WALL / 2,
    box.w + WALL * 2,
    WALL,
    { ...hidden, friction: 0.95 },
  );
  const left = Bodies.rectangle(
    box.x - WALL / 2,
    lip + wallH / 2,
    WALL,
    wallH,
    hidden,
  );
  const right = Bodies.rectangle(
    box.x + box.w + WALL / 2,
    lip + wallH / 2,
    WALL,
    wallH,
    hidden,
  );
  const back = [
    Bodies.rectangle(box.x + box.w / 2, floorY + WALL + BACKSTOP / 2, box.w + BACKSTOP * 2, BACKSTOP, hidden),
    Bodies.rectangle(box.x - WALL - BACKSTOP / 2, lip + wallH / 2, BACKSTOP, wallH + BACKSTOP, hidden),
    Bodies.rectangle(box.x + box.w + WALL + BACKSTOP / 2, lip + wallH / 2, BACKSTOP, wallH + BACKSTOP, hidden),
  ];
  walls = [floor, left, right, ...back];
  Composite.add(world, walls);
  containGrains();
}

function containGrains() {
  const box = view.inner;
  for (const body of grains) {
    const r = body.sandSize / 2;
    const minX = box.x + r + 0.5;
    const maxX = box.x + box.w - r - 0.5;
    const minY = fillLineY() + r + 0.5;
    const maxY = box.y + box.h - r - 0.5;
    const x = Math.min(Math.max(body.position.x, minX), maxX);
    const y = Math.min(Math.max(body.position.y, minY), maxY);
    if (x !== body.position.x || y !== body.position.y) {
      Body.setPosition(body, { x, y });
      Body.setVelocity(body, { x: 0, y: 0 });
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
  if (pointer.x < box.x || pointer.x > box.x + box.w) return null;
  if (pointer.y > box.y + box.h) return null;
  return { x: pointer.x, y: pointer.y };
}

function spawnGrain(origin) {
  const size = GRAIN_MIN + Math.random() * GRAIN_EXTRA;
  const half = size / 2;
  const box = view.inner;
  const ceiling = fillLineY() + half + 0.5;
  const reach = brushRadius();
  let spot = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * reach;
    const cx = origin.x + Math.cos(angle) * dist;
    const cy = origin.y + Math.sin(angle) * dist;
    if (cx < box.x + half + 1 || cx > box.x + box.w - half - 1) continue;
    if (cy < ceiling || cy > box.y + box.h - half - 1) continue;
    if (!overlaps(cx, cy, size, shape)) {
      spot = { x: cx, y: cy };
      break;
    }
  }
  if (!spot) return;

  const grainOptions = {
    restitution: 0,
    friction: shape === 'cube' ? 0.96 : 0.62,
    frictionStatic: shape === 'cube' ? 1.2 : 0.75,
    frictionAir: 0.012,
    density: 0.002,
    slop: 0,
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
  flow = DEFAULTS.flow;
  brush = DEFAULTS.brush;
  flowInput.value = String(flow);
  brushInput.value = String(brush);
  flowOut.textContent = String(flow);
  brushOut.textContent = String(brush);
  customInput.value = selected;
  syncColorUI();
  syncShapeUI();
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
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y - 24 && point.y <= box.y + box.h;
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

function drawGlassBowl() {
  const box = view.inner;
  ctx.save();
  ctx.shadowColor = 'rgba(70, 52, 28, 0.14)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = 'rgba(255, 252, 247, 0.55)';
  roundPath(box.x, box.y, box.w, box.h, 20);
  ctx.fill();
  ctx.restore();
}

function drawGlassRim() {
  const box = view.inner;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 6;
  roundPath(box.x + 3, box.y + 3, box.w - 6, box.h - 6, 16);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(74, 78, 86, 0.55)';
  ctx.lineWidth = 3;
  roundPath(box.x, box.y, box.w, box.h, 20);
  ctx.stroke();
  ctx.restore();
}

function drawFillLine() {
  const box = view.inner;
  const y = fillLineY();
  ctx.save();
  ctx.strokeStyle = 'rgba(74, 78, 86, 0.55)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(box.x + 14, y);
  ctx.lineTo(box.x + box.w - 14, y);
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
    emit(dt);
  }
  if (view) {
    draw();
    syncTransport();
  }
}

syncColorUI();
syncShapeUI();
syncTransport();
resize();
new ResizeObserver(resize).observe(document.getElementById('stage'));
requestAnimationFrame(frame);
