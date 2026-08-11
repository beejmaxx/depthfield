import "./style.css";

import {
  HISTORY_CAPACITY,
  HISTORY_INTERVAL_MS,
  INSTRUMENTS,
  SNAPSHOT_KIND,
  type Instrument,
  type UpdateFrame,
  decodeFrame,
  formatPrice,
} from "./protocol";
import {
  HeatmapRenderer,
  TIME_ZOOM_MAX,
  TIME_ZOOM_MIN,
  type BookLevel,
  type ViewState,
} from "./renderer";
import { HistoryRecorder, HistoryStore } from "./history-store";

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
const aggregationSelect = element<HTMLSelectElement>("aggregation");
const goLiveButton = element<HTMLButtonElement>("go-live");
const pauseButton = element<HTMLButtonElement>("pause");
const restartButton = element<HTMLButtonElement>("restart");
const exportHistoryButton = element<HTMLButtonElement>("export-history");
const importHistoryButton = element<HTMLButtonElement>("import-history");
const historyFileInput = element<HTMLInputElement>("history-file");
const worker = new Worker(new URL("./market.worker.ts", import.meta.url), { type: "module" });
const historyStore = new HistoryStore();
const historyRecorder = new HistoryRecorder(historyStore, (error) => {
  setHistoryStatus("LOCAL SAVE ERROR", error.message, true);
});

let baseInstrument = INSTRUMENTS[0];
let instrument: Instrument = { ...baseInstrument };
let renderer: HeatmapRenderer;
let paused = false;
let updateCount = 0;
let rateWindowStart = performance.now();
let lastBookUpdate = 0;
let connectionLabel = "CONNECTING";
let selectionGeneration = 0;
let recordingLive = false;
let noticeTimer = 0;
const bookRows = createBookRows();

try {
  renderer = await HeatmapRenderer.create(canvas, overlay, instrument);
  renderer.onFps = (fps) => { text("fps", fps.toString()); };
  renderer.onViewChange = syncViewControls;
  installControls();
  void selectInstrument(instrument);
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
    recordingLive = event.data.state === "live";
    historyRecorder.setEnabled(recordingLive);
    if (recordingLive) void refreshHistoryStatus();
    return;
  }
  const frame = decodeFrame(event.data);
  if (frame.kind === SNAPSHOT_KIND) {
    renderer.uploadSnapshot(frame);
    return;
  }
  renderer.uploadUpdate(frame);
  historyRecorder.record(frame);
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
    button.addEventListener("click", () => { void selectInstrument(candidate); });
    symbolNav.append(button);
  }
  contrastInput.addEventListener("input", () => renderer.setView({ contrast: contrastInput.valueAsNumber }));
  priceZoomInput.addEventListener("input", () => renderer.setView({ priceZoom: priceZoomInput.valueAsNumber }));
  timeZoomInput.addEventListener("input", () => renderer.setView({ timeZoom: sliderToTimeZoom(timeZoomInput.valueAsNumber) }));
  aggregationSelect.addEventListener("change", () => { void applyAggregation(Number(aggregationSelect.value)); });
  element<HTMLButtonElement>("reset").addEventListener("click", () => {
    renderer.setView({ contrast: 1.08, priceZoom: 1, timeZoom: 2.5, timeOffsetSeconds: 0 }, true);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-span]")) {
    button.addEventListener("click", () => {
      const seconds = Number(button.dataset.span);
      const baseSpan = (HISTORY_CAPACITY * HISTORY_INTERVAL_MS) / 1000;
      renderer.setView({ timeZoom: baseSpan / seconds, timeOffsetSeconds: 0 }, true);
    });
  }
  goLiveButton.addEventListener("click", () => renderer.setView({ timeOffsetSeconds: 0 }, true));
  pauseButton.addEventListener("click", () => {
    paused = !paused;
    renderer.paused = paused;
    pauseButton.innerHTML = paused ? "▶&nbsp; RESUME" : "Ⅱ&nbsp; PAUSE";
    worker.postMessage({ type: paused ? "pause" : "resume" });
    text("connection-label", paused ? "PAUSED" : connectionLabel);
  });
  restartButton.addEventListener("click", () => worker.postMessage({
    type: "restart",
    symbol: instrument.symbol,
    tickSize: instrument.tickSize,
  }));
  exportHistoryButton.addEventListener("click", () => { void exportHistory(); });
  importHistoryButton.addEventListener("click", () => historyFileInput.click());
  historyFileInput.addEventListener("change", () => { void importHistory(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void historyRecorder.flush();
  });
  window.addEventListener("pagehide", () => { void historyRecorder.flush(); });
  window.setInterval(() => { if (recordingLive) void refreshHistoryStatus(); }, 15_000);
}

async function selectInstrument(next: Instrument): Promise<void> {
  baseInstrument = next;
  populateAggregation(next);
  await applyAggregation(next.tickSize);
}

async function applyAggregation(tickSize: number): Promise<void> {
  const generation = ++selectionGeneration;
  recordingLive = false;
  historyRecorder.setEnabled(false);
  worker.postMessage({ type: "stop" });
  instrument = {
    ...baseInstrument,
    tickSize,
    decimals: Math.max(baseInstrument.decimals, decimalsForStep(tickSize)),
  };
  renderer.setInstrument(instrument);
  renderer.setView({ timeOffsetSeconds: 0 }, true);
  text("symbol", instrument.symbol);
  text("instrument-name", instrument.name);
  text("venue", instrument.venue);
  text("last-price", formatPrice(instrument.basePrice, instrument));
  for (const button of symbolNav.querySelectorAll("button")) {
    button.classList.toggle("active", button.getAttribute("data-symbol") === instrument.symbol);
  }
  setHistoryStatus("LOADING LOCAL HISTORY", "Restoring genuine depth recorded by this browser");
  try {
    await historyRecorder.useStream(instrument.symbol, instrument.tickSize);
    const history = await historyStore.loadRecent(instrument.symbol, instrument.tickSize);
    if (generation !== selectionGeneration) return;
    if (history.endTime > 0) renderer.uploadRecordedHistory(history);
    await refreshHistoryStatus();
    void historyStore.prune(instrument.symbol, instrument.tickSize);
  } catch (error) {
    if (generation !== selectionGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    setHistoryStatus("LOCAL HISTORY OFF", message, true);
  }
  if (generation !== selectionGeneration) return;
  worker.postMessage({ type: "start", symbol: instrument.symbol, tickSize: instrument.tickSize });
}

async function exportHistory(): Promise<void> {
  exportHistoryButton.disabled = true;
  try {
    await historyRecorder.flush();
    const blob = await historyStore.exportRecording(instrument.symbol, instrument.tickSize);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `depthfield-${instrument.symbol}-${new Date().toISOString().replace(/[:.]/g, "-")}.depthfield`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showNotice(`Exported ${formatBytes(blob.size)} of ${instrument.symbol} depth history.`);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    exportHistoryButton.disabled = false;
  }
}

async function importHistory(): Promise<void> {
  const file = historyFileInput.files?.[0];
  historyFileInput.value = "";
  if (!file) return;
  importHistoryButton.disabled = true;
  setHistoryStatus("IMPORTING HISTORY", file.name);
  try {
    await historyRecorder.flush();
    const imported = await historyStore.importRecording(file);
    const sameMarket = imported.symbol === instrument.symbol && Math.abs(imported.tickSize - instrument.tickSize) < 1e-10;
    showNotice(`Imported ${imported.symbol} recording with ${imported.chunks} history chunks.`);
    if (sameMarket) await applyAggregation(instrument.tickSize);
    else await refreshHistoryStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setHistoryStatus("IMPORT FAILED", message, true);
    showNotice(message, true);
  } finally {
    importHistoryButton.disabled = false;
  }
}

async function refreshHistoryStatus(): Promise<void> {
  if (!historyStore.available) {
    setHistoryStatus("LOCAL HISTORY UNAVAILABLE", "IndexedDB is disabled in this browser", true);
    return;
  }
  const stats = await historyStore.stats(instrument.symbol, instrument.tickSize);
  const state = recordingLive ? "RECORDING" : stats.samples > 0 ? "LOCAL HISTORY" : "LOCAL HISTORY READY";
  const summary = stats.samples > 0
    ? `${state} · ${formatDuration(Math.max(0, stats.endTime - stats.startTime))} · ${formatBytes(stats.bytes)}`
    : state;
  setHistoryStatus(summary, "Stored only in this browser. Export a portable .depthfield recording at any time.");
}

function setHistoryStatus(label: string, detail: string, error = false): void {
  const status = element("history-status");
  status.textContent = label;
  status.title = detail;
  status.classList.toggle("error", error);
}

function showNotice(message: string, error = false): void {
  const notice = element("history-notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.add("visible");
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => notice.classList.remove("visible"), 4_500);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function populateAggregation(next: Instrument): void {
  aggregationSelect.replaceChildren();
  for (const multiplier of [0.5, 1, 2, 5]) {
    const tickSize = next.tickSize * multiplier;
    const option = document.createElement("option");
    option.value = tickSize.toString();
    option.textContent = formatAggregation(tickSize);
    option.selected = multiplier === 1;
    aggregationSelect.append(option);
  }
}

function formatAggregation(step: number): string {
  return step.toLocaleString("en-US", {
    minimumFractionDigits: decimalsForStep(step),
    maximumFractionDigits: decimalsForStep(step),
  });
}

function decimalsForStep(step: number): number {
  const normalized = step.toFixed(8).replace(/0+$/, "");
  return normalized.includes(".") ? normalized.length - normalized.indexOf(".") - 1 : 0;
}

function syncViewControls(view: ViewState): void {
  contrastInput.value = view.contrast.toString();
  priceZoomInput.value = view.priceZoom.toString();
  timeZoomInput.value = timeZoomToSlider(view.timeZoom).toString();
  goLiveButton.disabled = view.timeOffsetSeconds < 0.05;
}

function sliderToTimeZoom(value: number): number {
  return TIME_ZOOM_MIN * Math.pow(TIME_ZOOM_MAX / TIME_ZOOM_MIN, value / 100);
}

function timeZoomToSlider(value: number): number {
  return 100 * Math.log(value / TIME_ZOOM_MIN) / Math.log(TIME_ZOOM_MAX / TIME_ZOOM_MIN);
}

function updateMetrics(frame: UpdateFrame): void {
  text("last-price", formatPrice(frame.midPrice, instrument));
  text("session-volume", frame.sessionVolume.toFixed(1));
  text("cumulative-delta", `${frame.cumulativeDelta >= 0 ? "+" : ""}${frame.cumulativeDelta.toFixed(1)}`);
  text("imbalance", `${frame.imbalance >= 0 ? "+" : ""}${(frame.imbalance * 100).toFixed(1)}%`);
  text("latency", `${Math.max(0, Math.round(Date.now() - frame.generatedAt))} ms`);
  text("depth-scale", `P99 ${frame.depthScale < 10 ? frame.depthScale.toFixed(2) : frame.depthScale.toFixed(1)}`);
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
