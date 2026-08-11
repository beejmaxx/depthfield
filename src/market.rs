use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const DEPTH_ROWS: usize = 72;
pub const MAX_HISTORY: usize = 600;
pub const MAX_TRADES: usize = 80;

#[derive(Clone, Copy, Debug)]
pub struct Instrument {
    pub symbol: &'static str,
    pub venue: &'static str,
    pub name: &'static str,
    pub base_price: f64,
    pub tick_size: f64,
    pub decimals: usize,
}

pub const INSTRUMENTS: [Instrument; 3] = [
    Instrument {
        symbol: "BTCUSDT",
        venue: "BINANCE",
        name: "Bitcoin / Tether",
        base_price: 118_432.5,
        tick_size: 0.5,
        decimals: 1,
    },
    Instrument {
        symbol: "ETHUSDT",
        venue: "BINANCE",
        name: "Ether / Tether",
        base_price: 4_218.32,
        tick_size: 0.05,
        decimals: 2,
    },
    Instrument {
        symbol: "ESU6",
        venue: "CME",
        name: "E-mini S&P 500",
        base_price: 6_412.75,
        tick_size: 0.25,
        decimals: 2,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Aggressor {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug)]
pub struct Trade {
    pub sequence: u64,
    pub price: f64,
    pub size: f64,
    pub aggressor: Aggressor,
}

#[derive(Clone, Copy, Debug)]
pub struct BookLevel {
    pub price: f64,
    pub bid_size: f64,
    pub ask_size: f64,
}

#[derive(Clone, Debug)]
pub struct HeatColumn {
    pub mid_price: f64,
    pub liquidity: Vec<f32>,
    pub trades: Vec<Trade>,
}

pub struct MarketEngine {
    instrument: Instrument,
    sequence: u64,
    mid_price: f64,
    anchor_price: f64,
    rng: u64,
    last_step: Instant,
    liquidity_state: Vec<f32>,
    walls: Vec<LiquidityWall>,
    pub history: VecDeque<HeatColumn>,
    pub trades: VecDeque<Trade>,
    pub book: Vec<BookLevel>,
    pub session_volume: f64,
    pub cumulative_delta: f64,
}

#[derive(Clone, Copy)]
struct LiquidityWall {
    row: usize,
    strength: f32,
    ttl: u32,
}

impl MarketEngine {
    pub fn new(instrument: Instrument) -> Self {
        let mut engine = Self {
            instrument,
            sequence: 0,
            mid_price: instrument.base_price,
            anchor_price: instrument.base_price,
            rng: instrument.base_price.to_bits() ^ 0x9e37_79b9_7f4a_7c15,
            last_step: Instant::now(),
            liquidity_state: vec![0.0; DEPTH_ROWS],
            walls: Vec::with_capacity(16),
            history: VecDeque::with_capacity(MAX_HISTORY),
            trades: VecDeque::with_capacity(MAX_TRADES),
            book: Vec::with_capacity(31),
            session_volume: 0.0,
            cumulative_delta: 0.0,
        };
        for row in 0..DEPTH_ROWS {
            engine.liquidity_state[row] = 0.025 + engine.random_unit() as f32 * 0.075;
        }
        for index in 0..14 {
            let side_offset = 4 + (index * 5) % (DEPTH_ROWS / 2 - 5);
            let row = if index % 2 == 0 {
                DEPTH_ROWS / 2 - side_offset
            } else {
                DEPTH_ROWS / 2 + side_offset
            };
            let strength = 0.28 + engine.random_unit() as f32 * 0.72;
            let ttl = 24 + (engine.random_unit() * 150.0) as u32;
            engine.walls.push(LiquidityWall { row, strength, ttl });
        }
        for _ in 0..MAX_HISTORY {
            engine.step();
        }
        engine.last_step = Instant::now();
        engine
    }

    pub fn instrument(&self) -> Instrument {
        self.instrument
    }

    pub fn mid_price(&self) -> f64 {
        self.mid_price
    }

    pub fn anchor_price(&self) -> f64 {
        self.anchor_price
    }

    pub fn current_liquidity(&self) -> &[f32] {
        &self.liquidity_state
    }

    pub fn imbalance(&self) -> f64 {
        let bids: f64 = self.book.iter().map(|level| level.bid_size).sum();
        let asks: f64 = self.book.iter().map(|level| level.ask_size).sum();
        if bids + asks == 0.0 {
            0.0
        } else {
            (bids - asks) / (bids + asks)
        }
    }

    pub fn set_instrument(&mut self, instrument: Instrument) {
        *self = Self::new(instrument);
    }

    pub fn update(&mut self, paused: bool) -> bool {
        if paused || self.last_step.elapsed() < Duration::from_millis(95) {
            return false;
        }
        self.last_step = Instant::now();
        self.step();
        true
    }

    fn step(&mut self) {
        self.sequence += 1;
        let drift = (self.random_unit() - 0.49) * self.instrument.tick_size * 1.55;
        let anchor = (self.instrument.base_price - self.mid_price) * 0.0018;
        self.mid_price += drift + anchor;
        self.mid_price =
            (self.mid_price / self.instrument.tick_size).round() * self.instrument.tick_size;

        let mid_row = (DEPTH_ROWS as f64 / 2.0
            - (self.mid_price - self.anchor_price) / self.instrument.tick_size)
            .round() as isize;
        for row in 0..DEPTH_ROWS {
            let noise = self.random_unit() as f32;
            let previous = self.liquidity_state[row];
            let baseline = 0.018 + noise.powf(3.2) * 0.065;
            self.liquidity_state[row] = (previous * 0.972 + baseline * 0.028).clamp(0.0, 1.0);
        }

        for index in 0..self.walls.len() {
            let mut wall = self.walls[index];
            if wall.ttl == 0 || self.random_unit() < 0.006 {
                let offset = 5 + (self.random_unit() * (DEPTH_ROWS as f64 / 2.0 - 7.0)) as usize;
                wall.row = if self.random_unit() > 0.5 {
                    DEPTH_ROWS / 2 + offset
                } else {
                    DEPTH_ROWS / 2 - offset
                }
                .min(DEPTH_ROWS - 2);
                wall.strength = 0.26 + self.random_unit() as f32 * 0.74;
                wall.ttl = 45 + (self.random_unit() * 280.0) as u32;
            } else {
                wall.ttl -= 1;
                wall.strength =
                    (wall.strength + (self.random_unit() as f32 - 0.5) * 0.025).clamp(0.22, 1.0);
            }
            self.walls[index] = wall;

            for radius in -1_i32..=1 {
                let row = wall.row as i32 + radius;
                if (0..DEPTH_ROWS as i32).contains(&row) {
                    let falloff = if radius == 0 { 1.0 } else { 0.22 };
                    let target = wall.strength * falloff;
                    let cell = &mut self.liquidity_state[row as usize];
                    *cell += (target - *cell) * 0.16;
                }
            }
        }

        for distance in -2_isize..=2 {
            let row = mid_row + distance;
            if (0..DEPTH_ROWS as isize).contains(&row) {
                self.liquidity_state[row as usize] *= if distance.abs() <= 1 { 0.38 } else { 0.72 };
            }
        }

        let trade_count = if self.random_unit() < 0.24 {
            0
        } else if self.random_unit() > 0.86 {
            2
        } else {
            1
        };
        let mut column_trades = Vec::with_capacity(trade_count);
        for _ in 0..trade_count {
            let aggressor = if self.random_unit() > 0.47 {
                Aggressor::Buy
            } else {
                Aggressor::Sell
            };
            let direction = if aggressor == Aggressor::Buy {
                1.0
            } else {
                -1.0
            };
            let price = self.mid_price
                + direction * self.instrument.tick_size * (self.random_unit() * 2.0).round();
            let size = 0.01 + self.random_unit().powf(2.6) * 3.2;
            let trade = Trade {
                sequence: self.sequence,
                price,
                size,
                aggressor,
            };
            self.session_volume += size;
            self.cumulative_delta += direction * size;
            self.trades.push_front(trade);
            column_trades.push(trade);
        }
        self.trades.truncate(MAX_TRADES);

        self.history.push_back(HeatColumn {
            mid_price: self.mid_price,
            liquidity: self.liquidity_state.clone(),
            trades: column_trades,
        });
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
        self.rebuild_book();
    }

    fn rebuild_book(&mut self) {
        self.book.clear();
        for offset in (-15_i32..=15).rev() {
            let price = self.mid_price + offset as f64 * self.instrument.tick_size;
            let row = (DEPTH_ROWS as f64 / 2.0
                - (price - self.anchor_price) / self.instrument.tick_size)
                .round() as isize;
            let resting = if (0..DEPTH_ROWS as isize).contains(&row) {
                0.15 + self.liquidity_state[row as usize] as f64 * 13.5
            } else {
                0.15
            };
            self.book.push(BookLevel {
                price,
                bid_size: if offset < 0 { resting } else { 0.0 },
                ask_size: if offset > 0 { resting } else { 0.0 },
            });
        }
    }

    fn random_unit(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 11) as f64 / ((1_u64 << 53) - 1) as f64
    }
}

pub fn format_price(value: f64, instrument: Instrument) -> String {
    format!("{:.*}", instrument.decimals, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_and_tape_remain_bounded() {
        let mut engine = MarketEngine::new(INSTRUMENTS[0]);
        for _ in 0..500 {
            engine.step();
        }
        assert_eq!(engine.history.len(), MAX_HISTORY);
        assert!(engine.trades.len() <= MAX_TRADES);
        assert_eq!(engine.history.back().unwrap().liquidity.len(), DEPTH_ROWS);
    }

    #[test]
    fn book_has_bids_and_asks_around_midpoint() {
        let engine = MarketEngine::new(INSTRUMENTS[2]);
        assert!(engine.book.iter().any(|level| level.bid_size > 0.0));
        assert!(engine.book.iter().any(|level| level.ask_size > 0.0));
        assert_eq!(engine.book.len(), 31);
    }

    #[test]
    fn completed_heatmap_columns_are_immutable() {
        let mut engine = MarketEngine::new(INSTRUMENTS[0]);
        let frozen = engine.history.back().unwrap().liquidity.clone();
        engine.step();
        assert_eq!(engine.history[MAX_HISTORY - 2].liquidity, frozen);
        assert_eq!(
            engine.history.back().unwrap().liquidity,
            engine.current_liquidity()
        );
    }
}
