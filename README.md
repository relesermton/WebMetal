# WebMetal — build

This folder is the complete, self-contained release. It contains only:

- `index.html`
- `styles.css`
- `main.js`, `math.js`, `webmetal.js`
- `README.md`

No subfolders, no build step, no dependencies, no server required.

## Run

Double-click `index.html` (or open it in any modern browser). It works from `file://`
because the scripts are plain classic scripts, not ES modules.

You can also serve the folder with any static server if you prefer, e.g.:

```bash
npx serve .
```

## What it is

A Metal-style rendering engine that rasterizes entirely on the CPU through Canvas2D.
No WebGPU, no WebGL, no GPU driver required. The demo renders a lit cube, an orbiting
icosahedron, a grid floor, and a gradient background.

## API

`webmetal.js` exposes `globalThis.WebMetal.WMDevice`. `math.js` exposes
`globalThis.WebMetalMath.mat4`.

```js
const device = await WMDevice.request(canvas);
const library = device.makeLibrary('lit.metal');
const pipeline = device.makeRenderPipeline({ library, vertexBuffers });
const frame = device.beginFrame();

frame.pass
  .setPipeline(pipeline)
  .setBindGroup(0, bindGroup)
  .setVertexBuffer(0, vertexBuffer)
  .setIndexBuffer(indexBuffer)
  .drawIndexed(indexCount);

frame.submit();
```

## Controls

- Drag to orbit · Scroll to zoom · Double-click to reset
- **O** auto-orbit · **W** wireframe · **R** reset · **Space** pause
