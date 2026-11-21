(function () {
/**
 * WebMetal — a Metal-style rendering engine that rasterizes entirely on the CPU
 * through Canvas2D. No WebGPU, WebGL, or GPU driver is required.
 *
 * The API mirrors Metal concepts (device, command queue, render pipelines,
 * buffers, render passes) and uses a painter's algorithm with per-primitive
 * Lambert + specular + rim lighting, fog, and a gradient background.
 */

const VERSION = '1.0.0';

function transform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const byte = (v) => Math.round(clamp(v, 0, 1) * 255);

function readUniforms(bindGroup) {
  const data = bindGroup.buffer.data;
  const result = {};
  for (const [name, type, offset] of bindGroup.buffer.layout) {
    result[name] = { type, offset: offset / 4, data };
  }
  return result;
}

const mat = (u) => u.data.subarray(u.offset, u.offset + 16);
const vec = (u) => [u.data[u.offset], u.data[u.offset + 1], u.data[u.offset + 2], u.data[u.offset + 3]];

/* ------------------------------------------------------------------ */
/* Device                                                              */
/* ------------------------------------------------------------------ */

class WMDevice {
  static async request(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D is unavailable; cannot display the scene.');
    return new WMDevice(ctx, canvas);
  }

  constructor(ctx, canvas) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.backend = 'Canvas2D';
    this.format = 'rgba8unorm';
    this.depthFormat = 'none';
    this.sampleCount = 1;
    this.width = 0;
    this.height = 0;
    this.lost = false;
    this.queue = { submit() {} };
    this.adapter = {
      info: {
        vendor: 'Software',
        architecture: 'Canvas2D',
        device: 'CPU rasterizer',
        description: 'Canvas2D software backend',
      },
    };
  }

  get label() {
    return 'Canvas2D software rasterizer';
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  beginFrame() {
    const commands = [];
    const pass = new SoftwarePass(this, commands);
    return { pass, submit: () => this.render(commands) };
  }

  makeCommandQueue() { return this.queue; }
  makeLibrary(source, label = 'WM shader library') {
    return {
      label: typeof source === 'string' ? source : (source?.label ?? label),
      check: async () => ({ messages: [] }),
    };
  }
  makeVertexBuffer(data, label) { return { kind: 'vertex', data, label }; }
  makeIndexBuffer(data, label) { return { kind: 'index', data, label }; }
  makeUniformBuffer(size, label, layout) {
    return {
      data: new Float32Array(size / 4),
      layout,
      label,
      write(data) { this.data = new Float32Array(data); return this; },
    };
  }
  createCommandEncoder() { return { beginRenderPass: () => new SoftwarePass(this, []) }; }
  makeRenderPipeline(desc) { return new SoftwarePipeline(desc); }

  /* --------------------------- raster ----------------------------- */

  render(commands) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    if (!W || !H) return;

    ctx.clearRect(0, 0, W, H);
    if (commands.some((c) => c.kind === 'background')) this.drawBackground(W, H);

    const primitives = [];
    for (const cmd of commands) {
      if (cmd.kind !== 'geometry') continue;
      this.buildPrimitives(cmd, primitives, W, H);
    }

    primitives.sort((a, b) => b.depth - a.depth);
    for (const p of primitives) {
      if (p.line) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.a[0], p.a[1]);
        ctx.lineTo(p.b[0], p.b[1]);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.a[0], p.a[1]);
        ctx.lineTo(p.b[0], p.b[1]);
        ctx.lineTo(p.c[0], p.c[1]);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
  }

  drawBackground(W, H) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgb(5, 7, 14)');
    grad.addColorStop(1, 'rgb(14, 19, 33)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.55);
    glow.addColorStop(0, 'rgba(14, 60, 92, 0.42)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  buildPrimitives(cmd, out, W, H) {
    const u = readUniforms(cmd.uniforms);
    const viewProj = mat(u.viewProj);
    const model = mat(u.model);
    const normalMat = mat(u.normalMat);
    const lightDir = normalize3(vec(u.lightDir));
    const tint = vec(u.tint);
    const camPos = vec(u.camPos);

    const data = cmd.vertices.data;
    const stride = cmd.pipeline.vertexLayout.arrayStride / 4;
    const verts = [];
    for (let i = 0; i < cmd.vertexCount; i++) {
      const o = i * stride;
      const pos = [data[o], data[o + 1], data[o + 2]];
      const nrm = [data[o + 3], data[o + 4], data[o + 5]];
      const col = [data[o + 6], data[o + 7], data[o + 8]];

      const world = transform(model, [...pos, 1]);
      const clip = transform(viewProj, world);
      const w = clip[3] || 1;
      const sx = (clip[0] / w * 0.5 + 0.5) * W;
      const sy = (1 - (clip[1] / w * 0.5 + 0.5)) * H;
      verts.push({
        screen: [sx, sy],
        depth: clip[2] / w,
        normal: normalize3(transform(normalMat, [...nrm, 0])),
        color: col,
        world: [world[0], world[1], world[2]],
      });
    }

    const indices = cmd.indices
      ? Array.from(cmd.indices.data.subarray(0, cmd.indexCount))
      : Array.from({ length: cmd.vertexCount }, (_, i) => i);

    const isLine = cmd.pipeline.topology === 'line-list';
    const step = isLine ? 2 : 3;
    for (let i = 0; i + step <= indices.length; i += step) {
      const tri = indices.slice(i, i + step).map((idx) => verts[idx]);
      if (tri.some((v) => !v)) continue;
      const count = tri.length;
      const average = (key, k) => tri.reduce((sum, v) => sum + v[key][k], 0) / count;

      const n = normalize3([0, 1, 2].map((k) => average('normal', k)));
      const base = [0, 1, 2].map((k) => average('color', k));
      const world = [0, 1, 2].map((k) => average('world', k));
      const view = normalize3([camPos[0] - world[0], camPos[1] - world[1], camPos[2] - world[2]]);
      const half = normalize3([lightDir[0] + view[0], lightDir[1] + view[1], lightDir[2] + view[2]]);

      const diff = Math.max(dot3(n, lightDir), 0);
      const spec = Math.pow(Math.max(dot3(n, half), 0), 48) * 0.55;
      const rim = Math.pow(1 - Math.max(dot3(n, view), 0), 3) * 0.30;
      const lit = [0, 1, 2].map((k) =>
        base[k] * tint[k] * (0.16 + diff * 0.92)
        + [1, 0.96, 0.9][k] * spec
        + [0.32, 0.62, 1][k] * rim * tint[3]
      );

      const dist = Math.hypot(camPos[0] - world[0], camPos[1] - world[1], camPos[2] - world[2]);
      const fog = clamp((dist - 6) / 13, 0, 0.72);
      const fogColor = [0.035, 0.055, 0.10];
      const finalColor = lit.map((c, k) => c * (1 - fog) + fogColor[k] * fog);
      const css = `rgb(${byte(finalColor[0])},${byte(finalColor[1])},${byte(finalColor[2])})`;

      const depth = tri.reduce((sum, v) => sum + v.depth, 0) / count;
      if (isLine) {
        out.push({ line: true, a: tri[0].screen, b: tri[1].screen, depth, color: css });
      } else {
        out.push({ line: false, a: tri[0].screen, b: tri[1].screen, c: tri[2].screen, depth, color: css });
      }
    }
  }
}

class SoftwarePipeline {
  constructor(desc) {
    this.vertexLayout = desc.vertexBuffers?.[0] ?? { arrayStride: 36 };
    this.topology = desc.topology ?? 'triangle-list';
    this.kind = desc.library?.label === 'background.metal' ? 'background' : 'geometry';
  }
  makeBindGroup(entries) { return { buffer: entries[0].resource }; }
}

class SoftwarePass {
  constructor(device, commands) {
    this.device = device;
    this.commands = commands;
    this.current = null;
  }
  setPipeline(p) { this.current = { pipeline: p }; return this; }
  setBindGroup(_i, bg) { this.current.uniforms = bg; return this; }
  setVertexBuffer(_s, b) { this.current.vertices = b; return this; }
  setIndexBuffer(b) { this.current.indices = b; return this; }
  draw(count) {
    this.current.vertexCount = count;
    this.commands.push({ kind: this.current.pipeline.kind, ...this.current });
    return this;
  }
  drawIndexed(count) {
    this.current.vertexCount = count;
    this.commands.push({ kind: this.current.pipeline.kind, ...this.current });
    return this;
  }
  end() { return this; }
}


globalThis.WebMetal = { WMDevice, VERSION };

})();
