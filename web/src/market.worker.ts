/// <reference lib="webworker" />

import {
  BOOK_LEVELS,
  COMMIT_HISTORY,
  DEPTH_ROWS,
  INSTRUMENTS,
  SNAPSHOT_KIND,
  UPDATE_FRAME_BYTES,
  UPDATE_HEADER_BYTES,
  UPDATE_KIND,
  type Instrument,
} from "./protocol";

const worker = self as DedicatedWorkerGlobalScope;
const INITIAL_HISTORY = 720;
const LIVE_INTERVAL_MS = 32;
const COMMIT_EVERY = 3;
const BINANCE_STREAM = "wss://data-stream.binance.vision/stream";
const BINANCE_REST = "https://data-api.binance.vision/api/v3/depth";

interface Wall {
  row: number;
  strength: number;
  ttl: number;
}

interface BinanceDepthEvent {
  e: "depthUpdate";
  E: number;
  U: number;
  u: number;
  b: Array<[string, string]>;
  a: Array<[string, string]>;
}

interface BinanceTradeEvent {
  e: "aggTrade";
  E: number;
  p: string;
  q: string;
  m: boolean;
}

interface BinanceSnapshot {
  lastUpdateId: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

interface WorkerCommand {
  type: "start" | "restart" | "pause" | "resume";
  symbol?: string;
  source?: "binance" | "simulation";
}

class MarketSimulation {
  readonly liquidity = new Float32Array(DEPTH_ROWS);
  readonly walls: Wall[] = [];
  readonly snapshotColumns = new Float32Array(INITIAL_HISTORY * DEPTH_ROWS);
  readonly snapshotMids = new Float32Array(INITIAL_HISTORY);
  instrument: Instrument;
  sequence = 0;
  midPrice: number;
  anchorPrice: number;
  sessionVolume = 0;
  cumulativeDelta = 0;
  imbalance = 0;
  rng: bigint;
  tickCounter = 0;

  constructor(instrument: Instrument) {
    this.instrument = instrument;
    this.midPrice = instrument.basePrice;
    this.anchorPrice = instrument.basePrice;
    this.rng = BigInt(Math.floor(instrument.basePrice * 1000)) ^ 0x9e3779b97f4a7c15n;
    this.reset();
  }

  reset(): void {
    this.sequence = 0;
    this.midPrice = this.instrument.basePrice;
    this.anchorPrice = this.instrument.basePrice;
    this.sessionVolume = 0;
    this.cumulativeDelta = 0;
    this.tickCounter = 0;
    this.walls.length = 0;
    for (let row = 0; row < DEPTH_ROWS; row += 1) this.liquidity[row] = 0.025 + this.random() * 0.075;
    for (let index = 0; index < 14; index += 1) {
      const sideOffset = 4 + ((index * 5) % (DEPTH_ROWS / 2 - 5));
      this.walls.push({
        row: index % 2 === 0 ? DEPTH_ROWS / 2 - sideOffset : DEPTH_ROWS / 2 + sideOffset,
        strength: 0.28 + this.random() * 0.72,
        ttl: 24 + Math.floor(this.random() * 150),
      });
    }
  }

  buildSnapshot(): ArrayBuffer {
    for (let column = 0; column < INITIAL_HISTORY; column += 1) {
      this.advance(true);
      this.snapshotMids[column] = this.midPrice;
      this.snapshotColumns.set(this.liquidity, column * DEPTH_ROWS);
    }
    return encodeSnapshot(this.snapshotMids, this.snapshotColumns, this.sequence);
  }

  nextUpdate(): ArrayBuffer {
    this.tickCounter += 1;
    const commit = this.tickCounter % COMMIT_EVERY === 0;
    const trade = this.advance(commit);
    return encodeUpdate({
      commit,
      sequence: this.sequence,
      midPrice: this.midPrice,
      anchorPrice: this.anchorPrice,
      sessionVolume: this.sessionVolume,
      cumulativeDelta: this.cumulativeDelta,
      imbalance: this.imbalance,
      tradePrice: trade.price,
      tradeSize: trade.size,
      tradeSide: trade.side,
      generatedAt: Date.now(),
      liquidity: this.liquidity,
      book: simulationBook(this),
    });
  }

  private advance(commit: boolean): { price: number; size: number; side: number } {
    this.sequence += 1;
    if (commit) {
      const drift = (this.random() - 0.49) * this.instrument.tickSize * 1.55;
      const anchorForce = (this.instrument.basePrice - this.midPrice) * 0.0018;
      this.midPrice += drift + anchorForce;
      this.midPrice = Math.round(this.midPrice / this.instrument.tickSize) * this.instrument.tickSize;
    }
    const midRow = Math.round(DEPTH_ROWS / 2 - (this.midPrice - this.anchorPrice) / this.instrument.tickSize);
    for (let row = 0; row < DEPTH_ROWS; row += 1) {
      const noise = this.random();
      const baseline = 0.018 + Math.pow(noise, 3.2) * 0.065;
      this.liquidity[row] = clamp(this.liquidity[row] * 0.975 + baseline * 0.025, 0, 1);
    }
    for (const wall of this.walls) {
      if (wall.ttl === 0 || this.random() < 0.0022) {
        const offset = 5 + Math.floor(this.random() * (DEPTH_ROWS / 2 - 7));
        wall.row = clampInt(this.random() > 0.5 ? DEPTH_ROWS / 2 + offset : DEPTH_ROWS / 2 - offset, 1, DEPTH_ROWS - 2);
        wall.strength = 0.26 + this.random() * 0.74;
        wall.ttl = 135 + Math.floor(this.random() * 840);
      } else {
        wall.ttl -= 1;
        wall.strength = clamp(wall.strength + (this.random() - 0.5) * 0.014, 0.22, 1);
      }
      for (let radius = -1; radius <= 1; radius += 1) {
        const row = wall.row + radius;
        if (row >= 0 && row < DEPTH_ROWS) {
          const target = wall.strength * (radius === 0 ? 1 : 0.22);
          this.liquidity[row] += (target - this.liquidity[row]) * 0.075;
        }
      }
    }
    for (let distance = -2; distance <= 2; distance += 1) {
      const row = midRow + distance;
      if (row >= 0 && row < DEPTH_ROWS) this.liquidity[row] *= Math.abs(distance) <= 1 ? 0.72 : 0.9;
    }
    let bidDepth = 0;
    let askDepth = 0;
    for (let offset = 1; offset <= 15; offset += 1) {
      bidDepth += this.liquidity[clampInt(midRow + offset, 0, DEPTH_ROWS - 1)];
      askDepth += this.liquidity[clampInt(midRow - offset, 0, DEPTH_ROWS - 1)];
    }
    this.imbalance = (bidDepth - askDepth) / Math.max(0.001, bidDepth + askDepth);
    if (!commit || this.random() < 0.23) return { price: 0, size: 0, side: 0 };
    const side = this.random() > 0.47 ? 1 : -1;
    const price = this.midPrice + side * this.instrument.tickSize * Math.round(this.random() * 2);
    const size = 0.01 + Math.pow(this.random(), 2.6) * 3.2;
    this.sessionVolume += size;
    this.cumulativeDelta += side * size;
    return { price, size, side };
  }

  private random(): number {
    this.rng ^= this.rng << 13n;
    this.rng ^= this.rng >> 7n;
    this.rng ^= this.rng << 17n;
    this.rng &= (1n << 64n) - 1n;
    return Number(this.rng >> 11n) / Number((1n << 53n) - 1n);
  }
}

class BinanceFeed {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  readonly bufferedDepth: BinanceDepthEvent[] = [];
  readonly liquidity = new Float32Array(DEPTH_ROWS);
  readonly book = new Float32Array(BOOK_LEVELS * 3);
  readonly instrument: Instrument;
  readonly generation: number;
  socket?: WebSocket;
  emitTimer?: number;
  connectTimer?: number;
  ready = false;
  closed = false;
  lastUpdateId = 0;
  sequence = 0;
  tickCounter = 0;
  midPrice: number;
  anchorPrice = 0;
  sessionVolume = 0;
  cumulativeDelta = 0;
  imbalance = 0;
  liquidityFloor = 0;
  liquidityCeiling = 1;
  hasLiquidityRange = false;
  tradePrice = 0;
  tradeSize = 0;
  tradeSide = 0;
  latestEventTime = Date.now();

  constructor(instrument: Instrument, generation: number) {
    this.instrument = instrument;
    this.generation = generation;
    this.midPrice = instrument.basePrice;
  }

  start(): void {
    postStatus("connecting", "BINANCE PUBLIC", "Direct public market-data connection");
    const symbol = this.instrument.symbol.toLowerCase();
    const streams = `${symbol}@depth@100ms/${symbol}@aggTrade`;
    this.socket = new WebSocket(`${BINANCE_STREAM}?streams=${streams}`);
    this.connectTimer = worker.setTimeout(() => this.fail("Connection timed out"), 8_000);
    this.socket.onopen = () => {
      postStatus("syncing", "BINANCE SYNC", "Synchronizing the public order-book snapshot");
      void this.syncSnapshot();
    };
    this.socket.onmessage = (event) => this.onMessage(event.data as string);
    this.socket.onerror = () => { /* onclose or the timeout handles recovery */ };
    this.socket.onclose = () => {
      if (!this.closed && this.generation === activeGeneration) this.fail("Market-data socket closed");
    };
  }

  stop(): void {
    this.closed = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    if (this.emitTimer !== undefined) clearInterval(this.emitTimer);
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }

  private onMessage(raw: string): void {
    const wrapper = JSON.parse(raw) as { data?: BinanceDepthEvent | BinanceTradeEvent };
    const data = wrapper.data;
    if (!data) return;
    if (data.e === "aggTrade") {
      const price = Number(data.p);
      const size = Number(data.q);
      const side = data.m ? -1 : 1;
      this.tradePrice = price;
      this.tradeSize += size;
      this.tradeSide = side;
      this.sessionVolume += size;
      this.cumulativeDelta += side * size;
      this.latestEventTime = data.E;
      return;
    }
    if (!this.ready) {
      this.bufferedDepth.push(data);
      if (this.bufferedDepth.length > 2_000) this.bufferedDepth.shift();
      return;
    }
    if (!this.applyDepth(data)) return;
    this.rebuildNormalizedBook();
  }

  private async syncSnapshot(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      const response = await fetch(`${BINANCE_REST}?symbol=${this.instrument.symbol}&limit=1000`, {
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Snapshot returned HTTP ${response.status}`);
      const snapshot = await response.json() as BinanceSnapshot;
      this.bids.clear();
      this.asks.clear();
      applyLevels(this.bids, snapshot.bids);
      applyLevels(this.asks, snapshot.asks);
      this.lastUpdateId = snapshot.lastUpdateId;
      const usable = this.bufferedDepth.filter((event) => event.u > this.lastUpdateId);
      let bridgeFound = usable.length === 0;
      for (const event of usable) {
        if (!bridgeFound) {
          if (event.U <= this.lastUpdateId + 1 && event.u >= this.lastUpdateId + 1) bridgeFound = true;
          else continue;
        }
        if (!this.applyDepth(event)) return;
      }
      this.bufferedDepth.length = 0;
      this.ready = true;
      if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
      this.rebuildNormalizedBook();
      postBuffer(encodeSnapshot(new Float32Array(0), new Float32Array(0), 0));
      this.emitTimer = worker.setInterval(() => this.emit(), LIVE_INTERVAL_MS);
      postStatus("live", "BINANCE PUBLIC", "Real-time public spot order book — no API key");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Snapshot synchronization failed");
    }
  }

  private applyDepth(event: BinanceDepthEvent): boolean {
    if (event.u <= this.lastUpdateId) return true;
    if (event.U > this.lastUpdateId + 1) {
      this.fail("Order-book sequence gap detected");
      return false;
    }
    applyLevels(this.bids, event.b);
    applyLevels(this.asks, event.a);
    this.lastUpdateId = event.u;
    this.latestEventTime = event.E;
    return true;
  }

  private rebuildNormalizedBook(): void {
    const bids = [...this.bids.entries()].sort((left, right) => right[0] - left[0]);
    const asks = [...this.asks.entries()].sort((left, right) => left[0] - right[0]);
    if (!bids.length || !asks.length) return;
    this.midPrice = (bids[0][0] + asks[0][0]) * 0.5;
    if (this.anchorPrice === 0) this.anchorPrice = Math.round(this.midPrice / this.instrument.tickSize) * this.instrument.tickSize;
    const recenterDistance = DEPTH_ROWS * this.instrument.tickSize * 0.28;
    if (Math.abs(this.midPrice - this.anchorPrice) > recenterDistance) {
      this.anchorPrice = Math.round(this.midPrice / this.instrument.tickSize) * this.instrument.tickSize;
      postBuffer(encodeSnapshot(new Float32Array(0), new Float32Array(0), this.sequence));
    }
    const sizes = new Float64Array(DEPTH_ROWS);
    for (const [price, size] of bids) addToBucket(sizes, price, size, this.anchorPrice, this.instrument.tickSize);
    for (const [price, size] of asks) addToBucket(sizes, price, size, this.anchorPrice, this.instrument.tickSize);
    const logs = [...sizes].filter((size) => size > 0).map((size) => Math.log1p(size)).sort((a, b) => a - b);
    const targetFloor = logs[Math.floor(logs.length * 0.45)] ?? 0;
    const targetCeiling = logs[Math.floor(logs.length * 0.98)] ?? 1;
    if (!this.hasLiquidityRange) {
      this.liquidityFloor = targetFloor;
      this.liquidityCeiling = targetCeiling;
      this.hasLiquidityRange = true;
    } else {
      this.liquidityFloor = this.liquidityFloor * 0.96 + targetFloor * 0.04;
      this.liquidityCeiling = this.liquidityCeiling * 0.96 + targetCeiling * 0.04;
    }
    const range = Math.max(0.08, this.liquidityCeiling - this.liquidityFloor);
    for (let row = 0; row < DEPTH_ROWS; row += 1) {
      if (sizes[row] === 0) this.liquidity[row] = 0;
      else {
        const normalized = clamp((Math.log1p(sizes[row]) - this.liquidityFloor) / range, 0, 1);
        this.liquidity[row] = 0.018 + Math.pow(normalized, 2.4) * 0.982;
      }
    }
    const topBids = bids.slice(0, 12);
    const topAsks = asks.slice(0, 12).reverse();
    this.book.fill(0);
    topAsks.forEach(([price, size], index) => setBookLevel(this.book, index, price, 0, size));
    setBookLevel(this.book, 12, this.midPrice, 0, 0);
    topBids.forEach(([price, size], index) => setBookLevel(this.book, 13 + index, price, size, 0));
    const bidDepth = topBids.reduce((total, level) => total + level[1], 0);
    const askDepth = topAsks.reduce((total, level) => total + level[1], 0);
    this.imbalance = (bidDepth - askDepth) / Math.max(0.0001, bidDepth + askDepth);
  }

  private emit(): void {
    if (paused || !this.ready || this.generation !== activeGeneration) return;
    this.sequence += 1;
    this.tickCounter += 1;
    const commit = this.tickCounter % COMMIT_EVERY === 0;
    postBuffer(encodeUpdate({
      commit,
      sequence: this.sequence,
      midPrice: this.midPrice,
      anchorPrice: this.anchorPrice || this.midPrice,
      sessionVolume: this.sessionVolume,
      cumulativeDelta: this.cumulativeDelta,
      imbalance: this.imbalance,
      tradePrice: this.tradePrice,
      tradeSize: this.tradeSize,
      tradeSide: this.tradeSide,
      generatedAt: this.latestEventTime,
      liquidity: this.liquidity,
      book: this.book,
    }));
    this.tradePrice = 0;
    this.tradeSize = 0;
    this.tradeSide = 0;
  }

  private fail(reason: string): void {
    if (this.closed || this.generation !== activeGeneration) return;
    this.stop();
    postStatus("fallback", "SIM FALLBACK", `Binance unavailable: ${reason}`);
    startSimulation(this.instrument, this.generation, false);
  }
}

interface UpdateValues {
  commit: boolean;
  sequence: number;
  midPrice: number;
  anchorPrice: number;
  sessionVolume: number;
  cumulativeDelta: number;
  imbalance: number;
  tradePrice: number;
  tradeSize: number;
  tradeSide: number;
  generatedAt: number;
  liquidity: Float32Array;
  book: Float32Array;
}

let simulation: MarketSimulation | undefined;
let simulationTimer: number | undefined;
let binanceFeed: BinanceFeed | undefined;
let paused = false;
let activeGeneration = 0;

function startMarket(symbol: string, source: "binance" | "simulation" = "binance"): void {
  activeGeneration += 1;
  stopActiveSource();
  paused = false;
  const instrument = INSTRUMENTS.find((candidate) => candidate.symbol === symbol) ?? INSTRUMENTS[0];
  if (source === "simulation") startSimulation(instrument, activeGeneration, true);
  else {
    binanceFeed = new BinanceFeed(instrument, activeGeneration);
    binanceFeed.start();
  }
}

function startSimulation(instrument: Instrument, generation: number, announce: boolean): void {
  if (generation !== activeGeneration) return;
  simulation = new MarketSimulation(instrument);
  postBuffer(simulation.buildSnapshot());
  if (announce) postStatus("simulation", "SIMULATION", "Deterministic local market simulation");
  simulationTimer = worker.setInterval(() => {
    if (paused || generation !== activeGeneration || !simulation) return;
    postBuffer(simulation.nextUpdate());
  }, LIVE_INTERVAL_MS);
}

function stopActiveSource(): void {
  binanceFeed?.stop();
  binanceFeed = undefined;
  simulation = undefined;
  if (simulationTimer !== undefined) clearInterval(simulationTimer);
  simulationTimer = undefined;
}

worker.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  if (command.type === "start" || command.type === "restart") startMarket(command.symbol ?? INSTRUMENTS[0].symbol, command.source ?? "binance");
  if (command.type === "pause") paused = true;
  if (command.type === "resume") paused = false;
};

function encodeSnapshot(midPrices: Float32Array, columns: Float32Array, sequence: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + (midPrices.length + columns.length) * 4);
  const view = new DataView(buffer);
  view.setUint32(0, SNAPSHOT_KIND, true);
  view.setUint32(4, midPrices.length, true);
  view.setUint32(8, DEPTH_ROWS, true);
  view.setUint32(12, sequence, true);
  new Float32Array(buffer, 16, midPrices.length).set(midPrices);
  new Float32Array(buffer, 16 + midPrices.length * 4, columns.length).set(columns);
  return buffer;
}

function encodeUpdate(values: UpdateValues): ArrayBuffer {
  const buffer = new ArrayBuffer(UPDATE_FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, UPDATE_KIND, true);
  view.setUint32(4, values.commit ? COMMIT_HISTORY : 0, true);
  view.setUint32(8, values.sequence, true);
  view.setUint32(12, DEPTH_ROWS, true);
  view.setFloat32(16, values.midPrice, true);
  view.setFloat32(20, values.sessionVolume, true);
  view.setFloat32(24, values.cumulativeDelta, true);
  view.setFloat32(28, values.imbalance, true);
  view.setFloat32(32, values.tradePrice, true);
  view.setFloat32(36, values.tradeSize, true);
  view.setFloat32(40, values.tradeSide, true);
  view.setFloat32(44, values.anchorPrice, true);
  view.setFloat64(48, values.generatedAt, true);
  new Float32Array(buffer, UPDATE_HEADER_BYTES, DEPTH_ROWS).set(values.liquidity);
  new Float32Array(buffer, UPDATE_HEADER_BYTES + DEPTH_ROWS * 4, BOOK_LEVELS * 3).set(values.book);
  return buffer;
}

function simulationBook(engine: MarketSimulation): Float32Array {
  const book = new Float32Array(BOOK_LEVELS * 3);
  const half = Math.floor(BOOK_LEVELS / 2);
  const currentRow = Math.round(DEPTH_ROWS / 2 - (engine.midPrice - engine.anchorPrice) / engine.instrument.tickSize);
  for (let index = 0; index < BOOK_LEVELS; index += 1) {
    const offset = half - index;
    const price = engine.midPrice + offset * engine.instrument.tickSize;
    const row = clampInt(currentRow - offset, 0, DEPTH_ROWS - 1);
    const resting = 0.15 + engine.liquidity[row] * 13.5;
    setBookLevel(book, index, price, offset < 0 ? resting : 0, offset > 0 ? resting : 0);
  }
  return book;
}

function applyLevels(target: Map<number, number>, levels: Array<[string, string]>): void {
  for (const [priceText, sizeText] of levels) {
    const price = Number(priceText);
    const size = Number(sizeText);
    if (size === 0) target.delete(price);
    else target.set(price, size);
  }
}

function addToBucket(sizes: Float64Array, price: number, size: number, anchor: number, tick: number): void {
  const row = Math.round(DEPTH_ROWS / 2 - (price - anchor) / tick);
  if (row >= 0 && row < DEPTH_ROWS) sizes[row] += size;
}

function setBookLevel(book: Float32Array, index: number, price: number, bid: number, ask: number): void {
  const offset = index * 3;
  book[offset] = price;
  book[offset + 1] = bid;
  book[offset + 2] = ask;
}

function postBuffer(buffer: ArrayBuffer): void {
  worker.postMessage(buffer, [buffer]);
}

function postStatus(state: string, label: string, detail: string): void {
  worker.postMessage({ type: "status", state, label, detail });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.trunc(clamp(value, minimum, maximum));
}

export {};
