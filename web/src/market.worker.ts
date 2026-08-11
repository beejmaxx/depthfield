/// <reference lib="webworker" />

import {
  COMMIT_HISTORY,
  DEPTH_ROWS,
  INSTRUMENTS,
  SNAPSHOT_KIND,
  UPDATE_HEADER_BYTES,
  UPDATE_KIND,
  type Instrument,
} from "./protocol";

const worker = self as DedicatedWorkerGlobalScope;
const INITIAL_HISTORY = 720;
const LIVE_INTERVAL_MS = 32;
const COMMIT_EVERY = 3;

interface Wall {
  row: number;
  strength: number;
  ttl: number;
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
    for (let row = 0; row < DEPTH_ROWS; row += 1) {
      this.liquidity[row] = 0.025 + this.random() * 0.075;
    }
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
    const headerBytes = 16;
    const buffer = new ArrayBuffer(headerBytes + (INITIAL_HISTORY + this.snapshotColumns.length) * 4);
    const view = new DataView(buffer);
    view.setUint32(0, SNAPSHOT_KIND, true);
    view.setUint32(4, INITIAL_HISTORY, true);
    view.setUint32(8, DEPTH_ROWS, true);
    view.setUint32(12, this.sequence, true);
    new Float32Array(buffer, headerBytes, INITIAL_HISTORY).set(this.snapshotMids);
    new Float32Array(buffer, headerBytes + INITIAL_HISTORY * 4, this.snapshotColumns.length).set(
      this.snapshotColumns,
    );
    return buffer;
  }

  nextUpdate(): ArrayBuffer {
    this.tickCounter += 1;
    const commit = this.tickCounter % COMMIT_EVERY === 0;
    const trade = this.advance(commit);
    const buffer = new ArrayBuffer(UPDATE_HEADER_BYTES + DEPTH_ROWS * 4);
    const view = new DataView(buffer);
    view.setUint32(0, UPDATE_KIND, true);
    view.setUint32(4, commit ? COMMIT_HISTORY : 0, true);
    view.setUint32(8, this.sequence, true);
    view.setUint32(12, DEPTH_ROWS, true);
    view.setFloat32(16, this.midPrice, true);
    view.setFloat32(20, this.sessionVolume, true);
    view.setFloat32(24, this.cumulativeDelta, true);
    view.setFloat32(28, this.imbalance, true);
    view.setFloat32(32, trade.price, true);
    view.setFloat32(36, trade.size, true);
    view.setFloat32(40, trade.side, true);
    view.setFloat64(48, Date.now(), true);
    new Float32Array(buffer, UPDATE_HEADER_BYTES, DEPTH_ROWS).set(this.liquidity);
    return buffer;
  }

  private advance(commit: boolean): { price: number; size: number; side: number } {
    this.sequence += 1;
    if (commit) {
      const drift = (this.random() - 0.49) * this.instrument.tickSize * 1.55;
      const anchorForce = (this.instrument.basePrice - this.midPrice) * 0.0018;
      this.midPrice += drift + anchorForce;
      this.midPrice = Math.round(this.midPrice / this.instrument.tickSize) * this.instrument.tickSize;
    }

    const midRow = Math.round(
      DEPTH_ROWS / 2 - (this.midPrice - this.anchorPrice) / this.instrument.tickSize,
    );
    for (let row = 0; row < DEPTH_ROWS; row += 1) {
      const noise = this.random();
      const baseline = 0.018 + Math.pow(noise, 3.2) * 0.065;
      this.liquidity[row] = clamp(this.liquidity[row] * 0.975 + baseline * 0.025, 0, 1);
    }

    for (const wall of this.walls) {
      if (wall.ttl === 0 || this.random() < 0.0022) {
        const offset = 5 + Math.floor(this.random() * (DEPTH_ROWS / 2 - 7));
        wall.row = clampInt(
          this.random() > 0.5 ? DEPTH_ROWS / 2 + offset : DEPTH_ROWS / 2 - offset,
          1,
          DEPTH_ROWS - 2,
        );
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
      if (row >= 0 && row < DEPTH_ROWS) {
        this.liquidity[row] *= Math.abs(distance) <= 1 ? 0.72 : 0.9;
      }
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

let simulation = new MarketSimulation(INSTRUMENTS[0]);
let timer: number | undefined;
let paused = false;

function start(symbol: string): void {
  const instrument = INSTRUMENTS.find((candidate) => candidate.symbol === symbol) ?? INSTRUMENTS[0];
  simulation = new MarketSimulation(instrument);
  const snapshot = simulation.buildSnapshot();
  worker.postMessage(snapshot, [snapshot]);
  if (timer !== undefined) clearInterval(timer);
  timer = worker.setInterval(() => {
    if (paused) return;
    const frame = simulation.nextUpdate();
    worker.postMessage(frame, [frame]);
  }, LIVE_INTERVAL_MS);
}

worker.onmessage = (event: MessageEvent<{ type: string; symbol?: string }>) => {
  const command = event.data;
  if (command.type === "start" || command.type === "restart") start(command.symbol ?? simulation.instrument.symbol);
  if (command.type === "pause") paused = true;
  if (command.type === "resume") paused = false;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.trunc(clamp(value, minimum, maximum));
}

export {};
