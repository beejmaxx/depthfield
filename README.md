# Depthfield

Depthfield is a clean-room, GPU-rendered market-depth workstation for native macOS and the web. It explores the general idea of liquidity heatmaps without using Bookmap code, assets, protocols, or reverse-engineered implementation details.

The repository currently contains two working prototypes:

- a native Rust/egui/wgpu macOS application
- a dedicated TypeScript/WebGPU browser application

Both currently use deterministic synthetic market data. They are rendering and interaction prototypes, not trading software and not yet connected to an exchange.

## Web application

The browser client is intentionally not an egui-to-WASM port. Its hot path is designed for the web:

- direct WebGPU heatmap rendering with one full-screen draw
- a 1,024-column circular GPU texture, so historical pixels are never shifted
- immutable committed history and a separately updated live-book texture
- binary transferable worker messages rather than JSON market events
- market simulation and decoding off the main UI thread
- batched history commits at roughly 10 Hz with live-book changes around 30 Hz
- shader-side colour mapping, contrast, time zoom, and price zoom
- DOM UI outside the chart, keeping the chart renderer independent

Run it locally:

```bash
cd web
npm install
npm run dev
```

Then open `http://127.0.0.1:5173`. A current WebGPU-capable browser and hardware acceleration are required.

Create an optimized build:

```bash
cd web
npm run build
npm run preview
```

Controls:

- mouse wheel over the chart: horizontal time zoom
- Shift + mouse wheel: vertical price zoom
- toolbar sliders: contrast, price zoom, and time zoom
- pause/resume: freeze and resume market updates

## Native macOS application

Run from source:

```bash
cargo run --release
```

Create a macOS application bundle:

```bash
sh scripts/package-macos.sh
open dist/Depthfield.app
```

## Architecture

```text
Exchange adapters / deterministic simulator
                    │
         compact normalized deltas
                    │
        binary WebSocket or Worker frames
                    │
          preallocated circular buffers
                    │
     WebGPU history texture + live texture
                    │
          candles, ladder, interactions
```

Important source boundaries:

- `src/market.rs` owns the native normalized market model and simulation.
- `src/heatmap.rs` draws the native heatmap with egui's GPU painter.
- `src/app.rs` owns the native workstation composition.
- `web/src/protocol.ts` defines the browser's compact binary frame contract.
- `web/src/market.worker.ts` owns off-main-thread simulated market updates.
- `web/src/renderer.ts` owns the circular WebGPU textures and chart rendering.
- `web/src/main.ts` connects the renderer, worker, and web-native controls.

The development server sends cross-origin-isolation headers so a future Rust/WASM engine can use shared memory without changing the frontend architecture.

## Production roadmap

1. Build a Rust feed service that normalizes exchange snapshots and sequenced deltas.
2. Replace the simulator transport with a compact binary WebSocket stream.
3. Add recording, deterministic replay, and gap recovery.
4. Move CPU-heavy aggregation into Rust/WASM only where profiling justifies it.
5. Add GPU-instanced trades, volume, annotations, and order placement overlays.
6. Validate latency, dropped-frame behavior, and book correctness against captured exchange data.

## License

MIT
