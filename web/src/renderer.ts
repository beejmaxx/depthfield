import {
  DEPTH_ROWS,
  HISTORY_CAPACITY,
  HISTORY_INTERVAL_MS,
  HISTORY_LEVEL_INTERVALS,
  HISTORY_LEVELS,
  type Instrument,
  type SnapshotFrame,
  type UpdateFrame,
  formatPrice,
} from "./protocol";

const PACKED_ROWS = DEPTH_ROWS / 4;
const TIME_AXIS_HEIGHT = 22;
const PRICE_AXIS_WIDTH = 78;
const LIVE_BOOK_WIDTH = 92;
export const TIME_ZOOM_MIN = 0.02;
export const TIME_ZOOM_MAX = 16;

const shader = /* wgsl */ `
struct Uniforms {
  canvas: vec4<f32>,
  view: vec4<f32>,
  market: vec4<f32>,
  history: vec4<f32>,
};

@group(0) @binding(0) var history_texture: texture_2d<f32>;
@group(0) @binding(1) var live_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

fn unpack_depth(texel: vec4<f32>, channel: i32) -> f32 {
  if (channel == 0) { return texel.r; }
  if (channel == 1) { return texel.g; }
  if (channel == 2) { return texel.b; }
  return texel.a;
}

fn history_depth(column: i32, row: i32) -> f32 {
  let level = i32(uniforms.view.z);
  let packed_row = row / 4 + level * (i32(uniforms.market.w) / 4);
  let channel = row - packed_row * 4;
  return unpack_depth(textureLoad(history_texture, vec2<i32>(column, packed_row), 0), channel);
}

fn live_depth(row: i32) -> f32 {
  let packed_row = row / 4;
  let channel = row - packed_row * 4;
  return unpack_depth(textureLoad(live_texture, vec2<i32>(0, packed_row), 0), channel);
}

fn color_ramp(value: f32) -> vec3<f32> {
  if (value < 0.12) {
    return mix(vec3<f32>(0.008, 0.035, 0.065), vec3<f32>(0.012, 0.12, 0.23), value / 0.12);
  }
  if (value < 0.32) {
    return mix(vec3<f32>(0.012, 0.15, 0.30), vec3<f32>(0.012, 0.42, 0.62), (value - 0.12) / 0.20);
  }
  if (value < 0.56) {
    return mix(vec3<f32>(0.015, 0.43, 0.62), vec3<f32>(0.09, 0.74, 0.39), (value - 0.32) / 0.24);
  }
  if (value < 0.78) {
    return mix(vec3<f32>(0.10, 0.74, 0.38), vec3<f32>(0.90, 0.82, 0.18), (value - 0.56) / 0.22);
  }
  if (value < 0.94) {
    return mix(vec3<f32>(0.94, 0.78, 0.13), vec3<f32>(0.97, 0.33, 0.06), (value - 0.78) / 0.16);
  }
  return mix(vec3<f32>(0.98, 0.30, 0.04), vec3<f32>(1.0, 0.035, 0.02), min(1.0, (value - 0.94) / 0.06));
}

@fragment
fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = position.xy / uniforms.canvas.xy;
  let history_end = uniforms.canvas.z;
  let plot_end = uniforms.canvas.w;
  let plot_bottom = uniforms.history.w;
  let base = vec3<f32>(0.008, 0.025, 0.034);

  if (uv.y >= plot_bottom) {
    return vec4<f32>(0.018, 0.045, 0.055, 1.0);
  }
  if (uv.x >= plot_end) {
    return vec4<f32>(0.022, 0.052, 0.061, 1.0);
  }

  let plot_y = uv.y / plot_bottom;
  let price_offset = (0.5 - plot_y) * uniforms.view.w;
  let price = uniforms.market.x + price_offset * uniforms.market.z;
  let row_f = uniforms.market.w * 0.5 - (price - uniforms.market.y) / uniforms.market.z;
  let row = i32(round(row_f));
  var raw = 0.0;
  var age = 1.0;

  if (row >= 0 && row < i32(uniforms.market.w)) {
    if (uv.x < history_end) {
      let count = i32(uniforms.history.x);
      if (count > 0) {
        let head = i32(uniforms.history.y);
        let capacity = i32(uniforms.history.z);
        let window = max(1, i32(floor(f32(capacity) / uniforms.view.y)));
        let visible = min(count, window);
        let skipped = max(0, count - visible);
        let padding = window - visible;
        let window_column = min(window - 1, i32(floor((uv.x / history_end) * f32(window))));
        if (window_column >= padding) {
          let logical = skipped + window_column - padding;
          let oldest = (head + capacity - count) % capacity;
          let physical = (oldest + logical) % capacity;
          raw = history_depth(physical, row);
          age = 0.72 + 0.28 * f32(window_column - padding) / max(1.0, f32(visible - 1));
        }
      }
    } else {
      raw = live_depth(row);
    }
  }

  let value = pow(clamp(raw * uniforms.view.x, 0.0, 1.0), 0.82);
  var color = mix(base, color_ramp(value), clamp(value * 1.28 + 0.08, 0.0, 1.0)) * age;

  let horizontal_grid = abs(fract(price_offset / 5.0 + 0.5) - 0.5);
  if (horizontal_grid < 0.018) { color += vec3<f32>(0.04, 0.055, 0.06); }
  if (uv.x < history_end) {
    let vertical_grid = abs(fract((uv.x / history_end) * 5.0 + 0.5) - 0.5);
    if (vertical_grid < 0.003) { color += vec3<f32>(0.03, 0.045, 0.05); }
  } else {
    color *= vec3<f32>(0.96, 1.02, 1.03);
  }

  let pixel_width = 1.35 / uniforms.canvas.x;
  if (abs(uv.x - history_end) < pixel_width) {
    color = vec3<f32>(0.70, 0.82, 0.82);
  }
  if (abs(uv.x - plot_end) < pixel_width * 0.7) {
    color = vec3<f32>(0.10, 0.17, 0.19);
  }
  return vec4<f32>(color, 1.0);
}
`;

export interface ViewState {
  contrast: number;
  priceZoom: number;
  timeZoom: number;
}

export interface BookLevel {
  price: number;
  bid: number;
  ask: number;
}

interface HistoryView {
  level: number;
  sampleMs: number;
  count: number;
  head: number;
  windowCount: number;
  shaderScale: number;
  spanSeconds: number;
}

export class HeatmapRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly historyTexture: GPUTexture;
  readonly liveTexture: GPUTexture;
  readonly uniformBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly pipeline: GPURenderPipeline;
  readonly midPrices = Array.from(
    { length: HISTORY_LEVELS },
    () => new Float32Array(HISTORY_CAPACITY),
  );
  readonly liveLiquidity = new Float32Array(DEPTH_ROWS);
  instrument: Instrument;
  view: ViewState = { contrast: 1.08, priceZoom: 1, timeZoom: 2.5 };
  readonly historyCounts = new Uint32Array(HISTORY_LEVELS);
  readonly historyHeads = new Uint32Array(HISTORY_LEVELS);
  historyCommitCount = 0;
  midPrice: number;
  anchorPrice: number;
  pointer: { x: number; y: number } | null = null;
  paused = false;
  onViewChange?: (view: ViewState) => void;
  onFps?: (fps: number) => void;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private frameCounter = 0;
  private fpsWindowStart = performance.now();
  private animationFrame = 0;

  static async create(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    instrument: Instrument,
  ): Promise<HeatmapRenderer> {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No compatible GPU adapter was found.");
    const device = await adapter.requestDevice();
    return new HeatmapRenderer(canvas, overlay, instrument, device);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    instrument: Instrument,
    device: GPUDevice,
  ) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.instrument = instrument;
    this.midPrice = instrument.basePrice;
    this.anchorPrice = instrument.basePrice;
    this.device = device;
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not create a WebGPU canvas context.");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    this.historyTexture = device.createTexture({
      label: "circular-liquidity-history",
      size: [HISTORY_CAPACITY, PACKED_ROWS * HISTORY_LEVELS],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.liveTexture = device.createTexture({
      label: "mutable-live-book",
      size: [1, PACKED_ROWS],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uniformBuffer = device.createBuffer({
      label: "heatmap-uniforms",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ label: "heatmap-shader", code: shader });
    this.pipeline = device.createRenderPipeline({
      label: "heatmap-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
    this.bindGroup = device.createBindGroup({
      label: "heatmap-bind-group",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.historyTexture.createView() },
        { binding: 1, resource: this.liveTexture.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    overlay.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    overlay.addEventListener("pointermove", (event) => {
      const bounds = overlay.getBoundingClientRect();
      this.pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    });
    overlay.addEventListener("pointerleave", () => { this.pointer = null; });
    this.device.lost.then((info) => console.error("WebGPU device lost", info));
    this.resize();
    this.renderLoop();
  }

  setInstrument(instrument: Instrument): void {
    this.instrument = instrument;
    this.midPrice = instrument.basePrice;
    this.anchorPrice = instrument.basePrice;
    this.historyCounts.fill(0);
    this.historyHeads.fill(0);
    this.historyCommitCount = 0;
    for (const prices of this.midPrices) prices.fill(0);
  }

  setView(next: Partial<ViewState>, notify = false): void {
    this.view = {
      contrast: clamp(next.contrast ?? this.view.contrast, 0.55, 1.8),
      priceZoom: clamp(next.priceZoom ?? this.view.priceZoom, 1, 3),
      timeZoom: clamp(next.timeZoom ?? this.view.timeZoom, TIME_ZOOM_MIN, TIME_ZOOM_MAX),
    };
    if (notify) this.onViewChange?.({ ...this.view });
  }

  uploadSnapshot(frame: SnapshotFrame): void {
    const packed = new Uint8Array(HISTORY_CAPACITY * PACKED_ROWS * HISTORY_LEVELS * 4);
    this.historyCounts.fill(0);
    this.historyHeads.fill(0);
    this.historyCommitCount = 0;
    for (let level = 0; level < HISTORY_LEVELS; level += 1) {
      const stride = HISTORY_LEVEL_INTERVALS[level] / HISTORY_INTERVAL_MS;
      const available = Math.ceil(frame.count / stride);
      const count = Math.min(available, HISTORY_CAPACITY);
      const sourceStart = Math.max(0, frame.count - count * stride);
      for (let column = 0; column < count; column += 1) {
        const sourceColumn = Math.min(frame.count - 1, sourceStart + (column + 1) * stride - 1);
        this.midPrices[level][column] = frame.midPrices[sourceColumn];
        for (let row = 0; row < DEPTH_ROWS; row += 1) {
          const packedRow = level * PACKED_ROWS + Math.floor(row / 4);
          const channel = row % 4;
          const target = (packedRow * HISTORY_CAPACITY + column) * 4 + channel;
          packed[target] = quantize(frame.columns[sourceColumn * DEPTH_ROWS + row]);
        }
      }
      this.historyCounts[level] = count;
      this.historyHeads[level] = count % HISTORY_CAPACITY;
    }
    this.device.queue.writeTexture(
      { texture: this.historyTexture },
      packed,
      { bytesPerRow: HISTORY_CAPACITY * 4, rowsPerImage: PACKED_ROWS * HISTORY_LEVELS },
      [HISTORY_CAPACITY, PACKED_ROWS * HISTORY_LEVELS],
    );
    this.midPrice = frame.midPrices[frame.count - 1] ?? this.instrument.basePrice;
  }

  uploadUpdate(frame: UpdateFrame): void {
    this.midPrice = frame.midPrice;
    this.anchorPrice = frame.anchorPrice;
    this.liveLiquidity.set(frame.liquidity);
    const packed = packColumn(frame.liquidity);
    this.device.queue.writeTexture(
      { texture: this.liveTexture },
      packed,
      { bytesPerRow: 4, rowsPerImage: PACKED_ROWS },
      [1, PACKED_ROWS],
    );
    if (!frame.commit) return;
    this.historyCommitCount += 1;
    for (let level = 0; level < HISTORY_LEVELS; level += 1) {
      const stride = HISTORY_LEVEL_INTERVALS[level] / HISTORY_INTERVAL_MS;
      if (level > 0 && this.historyCommitCount % stride !== 0) continue;
      const head = this.historyHeads[level];
      this.device.queue.writeTexture(
        { texture: this.historyTexture, origin: [head, level * PACKED_ROWS] },
        packed,
        { bytesPerRow: 4, rowsPerImage: PACKED_ROWS },
        [1, PACKED_ROWS],
      );
      this.midPrices[level][head] = frame.midPrice;
      this.historyHeads[level] = (head + 1) % HISTORY_CAPACITY;
      this.historyCounts[level] = Math.min(HISTORY_CAPACITY, this.historyCounts[level] + 1);
    }
  }

  getBook(levelCount = 25): BookLevel[] {
    const levels: BookLevel[] = [];
    const half = Math.floor(levelCount / 2);
    const currentRow = Math.round(
      DEPTH_ROWS / 2 - (this.midPrice - this.anchorPrice) / this.instrument.tickSize,
    );
    for (let displayOffset = half; displayOffset >= -half; displayOffset -= 1) {
      const price = this.midPrice + displayOffset * this.instrument.tickSize;
      const row = clampInt(currentRow - displayOffset, 0, DEPTH_ROWS - 1);
      const resting = 0.15 + this.liveLiquidity[row] * 13.5;
      levels.push({
        price,
        bid: displayOffset < 0 ? resting : 0,
        ask: displayOffset > 0 ? resting : 0,
      });
    }
    return levels;
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0014);
    if (event.shiftKey) this.setView({ priceZoom: this.view.priceZoom * factor }, true);
    else this.setView({ timeZoom: this.view.timeZoom * factor }, true);
  }

  private resize(): void {
    const bounds = this.canvas.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(bounds.width));
    this.height = Math.max(1, Math.floor(bounds.height));
    const pixelWidth = Math.floor(this.width * this.dpr);
    const pixelHeight = Math.floor(this.height * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.overlay.width = pixelWidth;
      this.overlay.height = pixelHeight;
    }
  }

  private renderLoop = (): void => {
    this.render();
    this.animationFrame = requestAnimationFrame(this.renderLoop);
  };

  destroy(): void {
    cancelAnimationFrame(this.animationFrame);
    this.historyTexture.destroy();
    this.liveTexture.destroy();
    this.uniformBuffer.destroy();
  }

  private render(): void {
    const pixelWidth = this.canvas.width;
    const pixelHeight = this.canvas.height;
    if (pixelWidth === 0 || pixelHeight === 0) return;
    const plotWidth = Math.max(100, this.width - PRICE_AXIS_WIDTH);
    const historyWidth = Math.max(50, plotWidth - LIVE_BOOK_WIDTH);
    const historyFraction = historyWidth / this.width;
    const plotFraction = plotWidth / this.width;
    const plotBottom = Math.max(0.5, (this.height - TIME_AXIS_HEIGHT) / this.height);
    const visibleRows = clamp(58 / Math.sqrt(this.view.priceZoom), 24, DEPTH_ROWS);
    const history = this.getHistoryView();
    const uniforms = new Float32Array([
      pixelWidth,
      pixelHeight,
      historyFraction,
      plotFraction,
      this.view.contrast,
      history.shaderScale,
      history.level,
      visibleRows,
      this.midPrice,
      this.anchorPrice,
      this.instrument.tickSize,
      DEPTH_ROWS,
      history.count,
      history.head,
      HISTORY_CAPACITY,
      plotBottom,
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    const encoder = this.device.createCommandEncoder({ label: "heatmap-frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.003, g: 0.012, b: 0.016, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.drawOverlay(historyWidth, plotWidth, this.height - TIME_AXIS_HEIGHT, visibleRows);
    this.frameCounter += 1;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 1000) {
      this.onFps?.(Math.round((this.frameCounter * 1000) / (now - this.fpsWindowStart)));
      this.frameCounter = 0;
      this.fpsWindowStart = now;
    }
  }

  private drawOverlay(historyWidth: number, plotWidth: number, plotHeight: number, visibleRows: number): void {
    const context = this.overlay.getContext("2d");
    if (!context) return;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    context.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";

    context.fillStyle = "rgba(164, 186, 189, .56)";
    context.fillText("LIQUIDITY · IMMUTABLE HISTORY", 10, 13);
    context.fillStyle = "#24d0ab";
    context.fillText("LIVE BOOK", historyWidth + 7, 13);

    const history = this.getHistoryView();
    const visibleCount = Math.min(history.count, history.windowCount);
    const skipped = Math.max(0, history.count - visibleCount);
    const leftPadding = Math.max(0, history.windowCount - visibleCount);
    const oldest = (history.head + HISTORY_CAPACITY - history.count) % HISTORY_CAPACITY;
    const priceToY = (price: number) =>
      plotHeight * 0.5 - ((price - this.midPrice) / this.instrument.tickSize) * (plotHeight / visibleRows);
    const candleSpan = Math.max(2, Math.round(history.windowCount / Math.max(30, historyWidth / 8)));

    context.lineWidth = 1;
    for (let start = 0; start < visibleCount; start += candleSpan) {
      const end = Math.min(visibleCount, start + candleSpan);
      let open = 0;
      let close = 0;
      let high = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      for (let offset = start; offset < end; offset += 1) {
        const physical = (oldest + skipped + offset) % HISTORY_CAPACITY;
        const price = this.midPrices[history.level][physical];
        if (offset === start) open = price;
        close = price;
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      if (!Number.isFinite(high) || open === 0) continue;
      const x = ((leftPadding + start + (end - start) * 0.5) / history.windowCount) * historyWidth;
      const candleWidth = Math.max(2, ((end - start) / history.windowCount) * historyWidth * 0.72);
      const openY = priceToY(open);
      const closeY = priceToY(close);
      const highY = priceToY(high + this.instrument.tickSize * 0.55);
      const lowY = priceToY(low - this.instrument.tickSize * 0.55);
      if (lowY < 0 || highY > plotHeight) continue;
      context.strokeStyle = "rgba(238, 245, 243, .92)";
      context.beginPath();
      context.moveTo(x, highY);
      context.lineTo(x, lowY);
      context.stroke();
      context.fillStyle = close >= open ? "#1fd66f" : "#f13c52";
      const bodyY = Math.min(openY, closeY) - 1;
      const bodyHeight = Math.max(2.5, Math.abs(closeY - openY) + 2);
      context.fillRect(x - candleWidth / 2, bodyY, candleWidth, bodyHeight);
      context.strokeRect(x - candleWidth / 2, bodyY, candleWidth, bodyHeight);
    }

    context.strokeStyle = "rgba(229, 241, 238, .72)";
    context.lineWidth = 0.8;
    context.beginPath();
    context.moveTo(0, plotHeight * 0.5);
    context.lineTo(plotWidth, plotHeight * 0.5);
    context.stroke();

    context.fillStyle = "rgba(6, 19, 23, .94)";
    context.fillRect(plotWidth, 0, PRICE_AXIS_WIDTH, plotHeight);
    context.strokeStyle = "#20353c";
    context.beginPath();
    context.moveTo(plotWidth + 0.5, 0);
    context.lineTo(plotWidth + 0.5, plotHeight);
    context.stroke();
    const halfRows = Math.ceil(visibleRows / 2);
    const labelStep = this.view.priceZoom > 1.7 ? 2 : 5;
    context.textAlign = "left";
    for (let offset = -halfRows; offset <= halfRows; offset += 1) {
      if (offset % labelStep !== 0) continue;
      const y = plotHeight * 0.5 - offset * (plotHeight / visibleRows);
      if (y < 8 || y > plotHeight - 8) continue;
      context.fillStyle = "#718b8f";
      context.fillText(formatPrice(this.midPrice + offset * this.instrument.tickSize, this.instrument), plotWidth + 7, y);
    }
    context.fillStyle = "#1ab88f";
    context.fillRect(plotWidth, plotHeight * 0.5 - 10, PRICE_AXIS_WIDTH, 20);
    context.fillStyle = "#031510";
    context.textAlign = "center";
    context.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(formatPrice(this.midPrice, this.instrument), plotWidth + PRICE_AXIS_WIDTH / 2, plotHeight * 0.5);

    context.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillStyle = "#526b70";
    context.textAlign = "center";
    for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
      context.fillText(`-${formatLookback((1 - fraction) * history.spanSeconds)}`, historyWidth * fraction, plotHeight + 11);
    }
    context.textAlign = "right";
    context.fillStyle = "#24d0ab";
    context.fillText("NOW", historyWidth - 4, plotHeight + 11);

    if (this.pointer && this.pointer.x < plotWidth && this.pointer.y < plotHeight) {
      context.strokeStyle = "rgba(220, 235, 232, .48)";
      context.lineWidth = 0.7;
      context.beginPath();
      context.moveTo(this.pointer.x, 0);
      context.lineTo(this.pointer.x, plotHeight);
      context.moveTo(0, this.pointer.y);
      context.lineTo(plotWidth, this.pointer.y);
      context.stroke();
      const rowsFromMid = (plotHeight * 0.5 - this.pointer.y) / (plotHeight / visibleRows);
      const pointerPrice = this.midPrice + rowsFromMid * this.instrument.tickSize;
      context.fillStyle = "rgba(13, 29, 34, .96)";
      context.fillRect(plotWidth, this.pointer.y - 10, PRICE_AXIS_WIDTH, 20);
      context.strokeStyle = "#526d72";
      context.strokeRect(plotWidth + 0.5, this.pointer.y - 9.5, PRICE_AXIS_WIDTH - 1, 19);
      context.textAlign = "center";
      context.fillStyle = "#dceae8";
      context.fillText(formatPrice(pointerPrice, this.instrument), plotWidth + PRICE_AXIS_WIDTH / 2, this.pointer.y);
    }
  }

  private getHistoryView(): HistoryView {
    const highResolutionSpan = (HISTORY_CAPACITY * HISTORY_INTERVAL_MS) / 1000;
    const requestedSpan = highResolutionSpan / this.view.timeZoom;
    let level = 0;
    for (let candidate = 1; candidate < HISTORY_LEVELS; candidate += 1) {
      const previousCapacity = (HISTORY_CAPACITY * HISTORY_LEVEL_INTERVALS[candidate - 1]) / 1000;
      if (requestedSpan > previousCapacity) level = candidate;
    }
    const sampleMs = HISTORY_LEVEL_INTERVALS[level];
    const windowCount = clampInt(Math.ceil((requestedSpan * 1000) / sampleMs), 1, HISTORY_CAPACITY);
    return {
      level,
      sampleMs,
      count: this.historyCounts[level],
      head: this.historyHeads[level],
      windowCount,
      shaderScale: HISTORY_CAPACITY / windowCount,
      spanSeconds: (windowCount * sampleMs) / 1000,
    };
  }
}

function formatLookback(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}:${minutes.toString().padStart(2, "0")}`;
}

function packColumn(liquidity: Float32Array): Uint8Array<ArrayBuffer> {
  const packed = new Uint8Array(DEPTH_ROWS);
  for (let row = 0; row < DEPTH_ROWS; row += 1) packed[row] = quantize(liquidity[row]);
  return packed;
}

function quantize(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.trunc(clamp(value, minimum, maximum));
}
