import "./style.css";

import {
  INSTRUMENTS,
  SNAPSHOT_KIND,
  type Instrument,
  type UpdateFrame,
  decodeFrame,
  formatPrice,
} from "./protocol";
import { HeatmapRenderer, type BookLevel, type ViewState } from "./renderer";

interface WorkerStatus {
  type: "status";
  state: string;
  label: string;
  detail: string;
}

const canvas = element<HTMLCanvasElement>("heatmap");
const overlay = element<HTMLCanvasElement>("overlay");
const gpuError = element<HTMLDivElement>("gpu-error");
const symbolNav = element<HTMLElement>("symbols");
const contrastInput = element<HTMLInputElement>("contrast");
const priceZoomInput = element<HTMLInputElement>("price-zoom");
const timeZoomInput = element<HTMLInputElement>("time-zoom");
const pauseButton = element<HTMLButtonElement>("pause");
const restartButton = element<HTMLButtonElement>("restart");
const worker = new Worker(new URL("./market.worker.ts", import.meta.url), { type: "module" });

let instrument = INSTRUMENTS[0];
let renderer: HeatmapRenderer;
let paused = false;
let updateCount = 0;
let rateWindowStart = performance.now();
let lastBookUpdate = 0;
let connectionLabel = "CONNECTING";
const bookRows = createBookRows();

try {
  renderer = await HeatmapRenderer.create(canvas, overlay, instrument);
  renderer.onFps = (fps) => { text("fps", fps.toString()); };
  renderer.onViewChange = syncViewControls;
  installControls();
  selectInstrument(instrument);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  gpuError.hidden = false;
  gpuError.textContent = `${message}\n\nDepthfield Web requires a current WebGPU-capable browser and hardware acceleration.`;
  worker.terminate();
  throw error;
}

worker.onmessage = (event: MessageEvent<ArrayBuffer | WorkerStatus>) => {
  if (!(event.data instanceof ArrayBuffer)) {
    connectionLabel = event.data.label;
    text("connection-label", paused ? "PAUSED" : event.data.label);
    const sourceStatus = event.data.state === "live"
      ? "LIVE BINANCE SPOT · NO API KEY"
      : event.data.state === "fallback"
        ? "LOCAL FALLBACK ACTIVE"
        : event.data.label;
    text("source-status", sourceStatus);
    element("connection-label").title = event.data.detail;
    return;
  }
  const frame = decodeFrame(event.data);
  if (frame.kind === SNAPSHOT_KIND) {
    renderer.uploadSnapshot(frame);
    return;
  }
  renderer.uploadUpdate(frame);
  updateMetrics(frame);
  updateCount += 1;
  const now = performance.now();
  if (now - lastBookUpdate >= 80) {
    updateBook(decodeBook(frame.book));
    lastBookUpdate = now;
  }
  if (now - rateWindowStart >= 1000) {
    text("event-rate", `${Math.round((updateCount * 1000) / (now - rateWindowStart))} updates/s`);
    updateCount = 0;
    rateWindowStart = now;
  }
};

worker.onerror = (event) => {
  text("connection-label", "WORKER ERROR");
  gpuError.hidden = false;
  gpuError.textContent = `Market worker error: ${event.message}`;
};

function installControls(): void {
  for (const candidate of INSTRUMENTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${candidate.symbol}  ${candidate.venue}`;
    button.dataset.symbol = candidate.symbol;
    button.addEventListener("click", () => selectInstrument(candidate));
    symbolNav.append(button);
  }
  contrastInput.addEventListener("input", () => renderer.setView({ contrast: contrastInput.valueAsNumber }));
  priceZoomInput.addEventListener("input", () => renderer.setView({ priceZoom: priceZoomInput.valueAsNumber }));
  timeZoomInput.addEventListener("input", () => renderer.setView({ timeZoom: timeZoomInput.valueAsNumber }));
  element<HTMLButtonElement>("reset").addEventListener("click", () => {
    renderer.setView({ contrast: 1.08, priceZoom: 1, timeZoom: 2.5 }, true);
  });
  pauseButton.addEventListener("click", () => {
    paused = !paused;
    renderer.paused = paused;
    pauseButton.innerHTML = paused ? "▶&nbsp; RESUME" : "Ⅱ&nbsp; PAUSE";
    worker.postMessage({ type: paused ? "pause" : "resume" });
    text("connection-label", paused ? "PAUSED" : connectionLabel);
  });
  restartButton.addEventListener("click", () => worker.postMessage({ type: "restart", symbol: instrument.symbol }));
}

function selectInstrument(next: Instrument): void {
  instrument = next;
  renderer.setInstrument(next);
  text("symbol", next.symbol);
  text("instrument-name", next.name);
  text("venue", next.venue);
  text("last-price", formatPrice(next.basePrice, next));
  for (const button of symbolNav.querySelectorAll("button")) {
    button.classList.toggle("active", button.getAttribute("data-symbol") === next.symbol);
  }
  worker.postMessage({ type: "start", symbol: next.symbol });
}

function syncViewControls(view: ViewState): void {
  contrastInput.value = view.contrast.toString();
  priceZoomInput.value = view.priceZoom.toString();
  timeZoomInput.value = view.timeZoom.toString();
}

function updateMetrics(frame: UpdateFrame): void {
  text("last-price", formatPrice(frame.midPrice, instrument));
  text("session-volume", frame.sessionVolume.toFixed(1));
  text("cumulative-delta", `${frame.cumulativeDelta >= 0 ? "+" : ""}${frame.cumulativeDelta.toFixed(1)}`);
  text("imbalance", `${frame.imbalance >= 0 ? "+" : ""}${(frame.imbalance * 100).toFixed(1)}%`);
  text("latency", `${Math.max(0, Math.round(Date.now() - frame.generatedAt))} ms`);
}

function createBookRows(): HTMLDivElement[] {
  const book = element<HTMLDivElement>("book");
  const rows: HTMLDivElement[] = [];
  for (let index = 0; index < 25; index += 1) {
    const row = document.createElement("div");
    row.className = "book-row";
    row.innerHTML = '<span class="bid"></span><span class="price"></span><span class="ask"></span>';
    book.append(row);
    rows.push(row);
  }
  return rows;
}

function updateBook(levels: BookLevel[]): void {
  const maximum = Math.max(1, ...levels.flatMap((level) => [level.bid, level.ask]));
  let bidTotal = 0;
  let askTotal = 0;
  levels.forEach((level, index) => {
    const row = bookRows[index];
    const spans = row.querySelectorAll<HTMLSpanElement>("span");
    spans[0].textContent = level.bid > 0 ? level.bid.toFixed(2) : "";
    spans[1].textContent = formatPrice(level.price, instrument);
    spans[2].textContent = level.ask > 0 ? level.ask.toFixed(2) : "";
    row.classList.toggle("mid", level.bid === 0 && level.ask === 0);
    row.style.setProperty("--bid-width", `${(level.bid / maximum) * 31}%`);
    row.style.setProperty("--ask-width", `${(level.ask / maximum) * 31}%`);
    bidTotal += level.bid;
    askTotal += level.ask;
  });
  text("bid-depth", bidTotal.toFixed(1));
  text("ask-depth", askTotal.toFixed(1));
}

function decodeBook(encoded: Float32Array): BookLevel[] {
  const levels: BookLevel[] = [];
  for (let index = 0; index < bookRows.length; index += 1) {
    const offset = index * 3;
    levels.push({ price: encoded[offset], bid: encoded[offset + 1], ask: encoded[offset + 2] });
  }
  return levels;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

function text(id: string, value: string): void {
  element(id).textContent = value;
}
