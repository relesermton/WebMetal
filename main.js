(function () {
const { WMDevice } = globalThis.WebMetal;
const { mat4 } = globalThis.WebMetalMath;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function createCube() {
  const faces = [
    { n: [0, 0, 1],  c: [1.00, 0.42, 0.42], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], c: [0.40, 0.80, 1.00], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0],  c: [1.00, 0.78, 0.35], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], c: [0.55, 0.95, 0.65], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0],  c: [0.98, 0.95, 0.70], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], c: [0.72, 0.55, 0.95], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];

  const vertices = [];
  const indices = [];
  let base = 0;
  for (const face of faces) {
    for (const p of face.v) vertices.push(...p, ...face.n, ...face.c);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function createCubeWireIndices() {
  const edges = new Map();
  for (let f = 0; f < 6; f++) {
    const b = f * 4;
    for (const [a, c] of [[b, b + 1], [b + 1, b + 2], [b + 2, b + 3], [b + 3, b]]) {
      edges.set(a < c ? `${a}_${c}` : `${c}_${a}`, [a, c]);
    }
  }
  return new Uint16Array([...edges.values()].flat());
}

function createIcosahedron(radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  const positions = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const vertices = [];
  for (const [x, y, z] of positions) {
    const l = Math.hypot(x, y, z);
    const nx = x / l, ny = y / l, nz = z / l;
    vertices.push(nx * radius, ny * radius, nz * radius, nx, ny, nz, 1.0, 0.82, 0.42);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(faces.flat()) };
}

function createGrid(half = 6, step = 0.5, y = -1.75) {
  const vertices = [];
  const up = [0, 1, 0];
  for (let i = -half; i <= half + 1e-6; i += step) {
    const fade = 1 - Math.abs(i) / half;
    const c = [0.18 + fade * 0.10, 0.34 + fade * 0.20, 0.48 + fade * 0.22];
    vertices.push(-half, y, i, ...up, ...c, half, y, i, ...up, ...c);
    vertices.push(i, y, -half, ...up, ...c, i, y, half, ...up, ...c);
  }
  return { vertices: new Float32Array(vertices) };
}

/* --------------------- Uniform layouts (CPU side) ------------------- */

const OBJECT_UNIFORM_LAYOUT = [
  ['viewProj', 'mat4', 0],
  ['model', 'mat4', 64],
  ['normalMat', 'mat4', 128],
  ['lightDir', 'vec4', 192],
  ['tint', 'vec4', 208],
  ['camPos', 'vec4', 224],
  ['misc', 'vec4', 240],
];
const BG_UNIFORM_LAYOUT = [['resolution', 'vec4', 0]];

/* ------------------------------------------------------------------ */
/* App state & DOM                                                     */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('wm-canvas');
const overlay = document.getElementById('overlay');
const ovTitle = document.getElementById('ov-title');
const ovMsg = document.getElementById('ov-msg');
const ovDetail = document.getElementById('ov-detail');

const el = {
  fps: document.getElementById('s-fps'),
  frame: document.getElementById('s-frame'),
  draws: document.getElementById('s-draws'),
  tris: document.getElementById('s-tris'),
  res: document.getElementById('s-res'),
  samples: document.getElementById('s-samples'),
  backend: document.getElementById('s-backend'),
};

const state = {
  yaw: 0.62,
  pitch: 0.34,
  distance: 7.6,
  autoOrbit: true,
  wireframe: false,
  paused: false,
  dragging: false,
  lastX: 0,
  lastY: 0,
  time: 0,
};

const setActive = (btn, active) => btn.classList.toggle('active', active);

function showError(title, message, detail = '') {
  overlay.classList.remove('hidden');
  overlay.classList.add('error');
  ovTitle.textContent = title;
  ovMsg.textContent = message;
  ovDetail.textContent = detail;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function start(wm) {
  const backendName = wm.backend;
  document.documentElement.dataset.backend = backendName.toLowerCase();

  ovMsg.textContent = 'Setting up the rasterizer…';
  const litLib = wm.makeLibrary('lit.metal');
  const bgLib = wm.makeLibrary('background.metal');
  await Promise.all([litLib.check(), bgLib.check()]);

  ovMsg.textContent = 'Building pipelines & buffers…';

  const vertexLayout = [{
    arrayStride: 36,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
    ],
  }];

  const bgPipeline = wm.makeRenderPipeline({
    label: 'background pipeline',
    library: bgLib,
    vertexBuffers: [],
    depthStencil: { format: wm.depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
  });

  const litPipeline = wm.makeRenderPipeline({
    label: 'lit pipeline',
    library: litLib,
    vertexBuffers: vertexLayout,
  });

  const linePipeline = wm.makeRenderPipeline({
    label: 'line pipeline',
    library: litLib,
    vertexBuffers: vertexLayout,
    topology: 'line-list',
    cullMode: 'none',
  });

  const cube = createCube();
  const cubeWire = createCubeWireIndices();
  const ico = createIcosahedron(1.0);
  const grid = createGrid();

  const cubeVB = wm.makeVertexBuffer(cube.vertices, 'cube vertices');
  const cubeIB = wm.makeIndexBuffer(cube.indices, 'cube indices');
  const cubeWireIB = wm.makeIndexBuffer(cubeWire, 'cube wire indices');
  const icoVB = wm.makeVertexBuffer(ico.vertices, 'icosahedron vertices');
  const icoIB = wm.makeIndexBuffer(ico.indices, 'icosahedron indices');
  const gridVB = wm.makeVertexBuffer(grid.vertices, 'grid vertices');

  const cubeUB = wm.makeUniformBuffer(256, 'cube uniforms', OBJECT_UNIFORM_LAYOUT);
  const icoUB = wm.makeUniformBuffer(256, 'icosahedron uniforms', OBJECT_UNIFORM_LAYOUT);
  const gridUB = wm.makeUniformBuffer(256, 'grid uniforms', OBJECT_UNIFORM_LAYOUT);
  const bgUB = wm.makeUniformBuffer(16, 'background uniforms', BG_UNIFORM_LAYOUT);

  const cubeBG = litPipeline.makeBindGroup([{ binding: 0, resource: cubeUB }]);
  const cubeWireBG = linePipeline.makeBindGroup([{ binding: 0, resource: cubeUB }]);
  const icoBG = litPipeline.makeBindGroup([{ binding: 0, resource: icoUB }]);
  const gridBG = linePipeline.makeBindGroup([{ binding: 0, resource: gridUB }]);
  const bgBG = bgPipeline.makeBindGroup([{ binding: 0, resource: bgUB }]);

  const uniformData = new Float32Array(64);
  const bgData = new Float32Array(4);

  const proj = mat4.create();
  const view = mat4.create();
  const viewProj = mat4.create();
  const model = mat4.create();
  const normalMat = mat4.create();
  const rotA = mat4.create();
  const rotB = mat4.create();
  const tmp = mat4.create();
  const eye = new Float32Array(3);
  const lightDir = new Float32Array([0.45, 0.85, 0.35, 0]);

  function writeUniforms(buffer, modelMatrix, tint, camPos, time) {
    uniformData.fill(0);
    uniformData.set(viewProj, 0);
    uniformData.set(modelMatrix, 16);
    mat4.normalFromMat4(normalMat, modelMatrix);
    uniformData.set(normalMat, 32);
    uniformData.set(lightDir, 48);
    uniformData.set(tint, 52);
    uniformData.set(camPos, 56);
    uniformData[60] = time;
    buffer.write(uniformData);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (wm.resize(w, h)) {
      el.res.textContent = `${w}×${h}`;
      bgData[0] = w;
      bgData[1] = h;
    }
  }
  window.addEventListener('resize', resize);
  resize();

  /* --------------------------- input ----------------------------- */

  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    const dx = e.clientX - state.lastX;
    const dy = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.yaw -= dx * 0.006;
    state.pitch = Math.max(-1.25, Math.min(1.25, state.pitch + dy * 0.006));
  });
  const endDrag = () => { state.dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.distance = Math.max(3.2, Math.min(18, state.distance * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });
  canvas.addEventListener('dblclick', resetView);

  const btnOrbit = document.getElementById('btn-orbit');
  const btnWire = document.getElementById('btn-wire');
  const btnPause = document.getElementById('btn-pause');
  const btnReset = document.getElementById('btn-reset');

  function resetView() {
    state.yaw = 0.62;
    state.pitch = 0.34;
    state.distance = 7.6;
  }
  function toggleOrbit() { state.autoOrbit = !state.autoOrbit; setActive(btnOrbit, state.autoOrbit); }
  function toggleWire() { state.wireframe = !state.wireframe; setActive(btnWire, state.wireframe); }
  function togglePause() { state.paused = !state.paused; setActive(btnPause, state.paused); btnPause.lastChild.textContent = state.paused ? ' Resume' : ' Pause'; }

  btnOrbit.addEventListener('click', toggleOrbit);
  btnWire.addEventListener('click', toggleWire);
  btnPause.addEventListener('click', togglePause);
  btnReset.addEventListener('click', resetView);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'o') toggleOrbit();
    else if (k === 'w') toggleWire();
    else if (k === 'r') resetView();
    else if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  });

  /* --------------------------- frame ----------------------------- */

  el.samples.textContent = 'CPU';
  el.draws.textContent = '4';
  el.tris.textContent = '32';
  el.backend.textContent = backendName;

  overlay.classList.add('hidden');
  console.info(`[WebMetal 1.0.0] ready — ${wm.label}`);

  let last = performance.now();
  let accum = 0;
  let frames = 0;
  let frameMs = 0;

  function frame(now) {
    const rawDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    frameMs = frameMs * 0.9 + (now - (frame.prev ?? now)) * 0.1;
    frame.prev = now;

    if (!state.paused) state.time += rawDt;
    if (state.autoOrbit && !state.dragging && !state.paused) state.yaw += rawDt * 0.10;

    const t = state.time;
    const cp = Math.cos(state.pitch);
    eye[0] = state.distance * Math.sin(state.yaw) * cp;
    eye[1] = state.distance * Math.sin(state.pitch) + 0.5;
    eye[2] = state.distance * Math.cos(state.yaw) * cp;

    mat4.perspective(proj, Math.PI / 4, wm.width / wm.height, 0.1, 100);
    mat4.lookAt(view, eye, [0, 0, 0], [0, 1, 0]);
    mat4.multiply(viewProj, proj, view);

    // Cube: translate * rotateY * rotateX
    mat4.rotationY(rotA, t * 0.48);
    mat4.rotationX(rotB, t * 0.27);
    mat4.multiply(model, rotA, rotB);
    mat4.translation(tmp, 0, 0.25, 0);
    mat4.multiply(model, tmp, model);
    writeUniforms(cubeUB, model, [1, 1, 1, 1], eye, t);

    // Icosahedron: orbiting the cube
    const a = t * 0.85;
    mat4.rotationY(rotA, t * 1.15);
    mat4.rotationZ(rotB, t * 0.65);
    mat4.multiply(model, rotA, rotB);
    mat4.scaling(tmp, 0.52, 0.52, 0.52);
    mat4.multiply(model, model, tmp);
    mat4.translation(tmp, Math.cos(a) * 2.65, Math.sin(t * 1.4) * 0.55, Math.sin(a) * 2.65);
    mat4.multiply(model, tmp, model);
    writeUniforms(icoUB, model, [1, 1, 1, 0.35], eye, t);

    // Grid uses the identity model
    mat4.identity(model);
    writeUniforms(gridUB, model, [0.85, 0.95, 1.1, 0], eye, t);

    bgData[2] = t;
    bgUB.write(bgData);

    const frameCtx = wm.beginFrame();
    const pass = frameCtx.pass;

    pass.setPipeline(bgPipeline).setBindGroup(0, bgBG).draw(3);

    pass.setPipeline(linePipeline).setBindGroup(0, gridBG)
      .setVertexBuffer(0, gridVB).draw(grid.vertices.length / 9);

    if (state.wireframe) {
      pass.setPipeline(linePipeline).setBindGroup(0, cubeWireBG)
        .setVertexBuffer(0, cubeVB).setIndexBuffer(cubeWireIB)
        .drawIndexed(cubeWire.length);
    } else {
      pass.setPipeline(litPipeline).setBindGroup(0, cubeBG)
        .setVertexBuffer(0, cubeVB).setIndexBuffer(cubeIB)
        .drawIndexed(cube.indices.length);
    }

    pass.setPipeline(litPipeline).setBindGroup(0, icoBG)
      .setVertexBuffer(0, icoVB).setIndexBuffer(icoIB)
      .drawIndexed(ico.indices.length);

    frameCtx.submit();

    accum += rawDt;
    frames++;
    if (accum >= 0.5) {
      el.fps.textContent = (frames / accum).toFixed(0);
      el.frame.textContent = `${frameMs.toFixed(1)} ms`;
      accum = 0;
      frames = 0;
    }

    requestAnimationFrame(frame);
  }

  // Small inspection hook (handy for debugging / automated checks).
  globalThis.WebMetal = { device: wm, frame };

  requestAnimationFrame(frame);
}

async function boot() {
  ovMsg.textContent = 'Initializing Canvas2D rasterizer…';
  try {
    const wm = await WMDevice.request(canvas);
    await start(wm);
  } catch (err) {
    console.error(err);
    showError('Unable to start WebMetal', err?.message ?? String(err), err?.stack ?? '');
  }
}

boot();

})();
