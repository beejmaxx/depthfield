use std::time::Duration;

use eframe::egui::{self, Align, Color32, FontFamily, FontId, Layout, RichText, Stroke, Vec2};

use crate::heatmap::{self, HeatmapSettings};
use crate::market::{Aggressor, INSTRUMENTS, Instrument, MarketEngine, format_price};

const BG: Color32 = Color32::from_rgb(6, 12, 15);
const PANEL: Color32 = Color32::from_rgb(10, 18, 22);
const PANEL_2: Color32 = Color32::from_rgb(13, 24, 29);
const LINE: Color32 = Color32::from_rgb(29, 43, 49);
const TEXT: Color32 = Color32::from_rgb(219, 231, 230);
const MUTED: Color32 = Color32::from_rgb(107, 129, 132);
const GREEN: Color32 = Color32::from_rgb(36, 208, 171);
const RED: Color32 = Color32::from_rgb(255, 86, 114);
const YELLOW: Color32 = Color32::from_rgb(232, 203, 87);

#[derive(Clone, Copy, PartialEq, Eq)]
enum RightPanel {
    Book,
    Trades,
}

pub struct DepthfieldApp {
    engine: MarketEngine,
    selected_instrument: usize,
    paused: bool,
    right_panel: RightPanel,
    heatmap: HeatmapSettings,
    frame_count: u64,
}

impl DepthfieldApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        configure_style(&cc.egui_ctx);
        Self {
            engine: MarketEngine::new(INSTRUMENTS[0]),
            selected_instrument: 0,
            paused: false,
            right_panel: RightPanel::Book,
            heatmap: HeatmapSettings {
                contrast: 1.08,
                zoom: 1.0,
                time_zoom: 2.5,
                show_trades: false,
            },
            frame_count: 0,
        }
    }

    fn top_bar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("top_bar")
            .exact_height(48.0)
            .frame(
                egui::Frame::new()
                    .fill(Color32::from_rgb(7, 15, 18))
                    .stroke(Stroke::new(1.0, LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.add_space(10.0);
                    ui.label(RichText::new("◆").strong().color(GREEN).size(17.0));
                    ui.label(
                        RichText::new("DEPTHFIELD")
                            .strong()
                            .color(TEXT)
                            .monospace()
                            .size(12.0),
                    );
                    ui.label(RichText::new("LABS").color(MUTED).monospace().size(8.0));
                    ui.separator();

                    let mut next_instrument = None;
                    for (index, instrument) in INSTRUMENTS.iter().enumerate() {
                        let selected = self.selected_instrument == index;
                        let text = format!("{}  {}", instrument.symbol, instrument.venue);
                        if ui
                            .selectable_label(selected, RichText::new(text).monospace().size(9.0))
                            .clicked()
                        {
                            next_instrument = Some(index);
                        }
                    }
                    if let Some(index) = next_instrument {
                        self.selected_instrument = index;
                        self.engine.set_instrument(INSTRUMENTS[index]);
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.add_space(10.0);
                        ui.label(RichText::new("42 ms").color(MUTED).monospace().size(8.0));
                        ui.label(
                            RichText::new("●  SIMULATION")
                                .color(GREEN)
                                .monospace()
                                .size(8.0),
                        );
                    });
                });
            });
    }

    fn instrument_bar(&mut self, ctx: &egui::Context) {
        let instrument = self.engine.instrument();
        egui::TopBottomPanel::top("instrument_bar")
            .exact_height(64.0)
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .stroke(Stroke::new(1.0, LINE))
                    .inner_margin(egui::Margin::symmetric(16, 8)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new(instrument.symbol)
                                    .strong()
                                    .monospace()
                                    .size(16.0),
                            );
                            ui.label(RichText::new(instrument.name).color(MUTED).size(9.0));
                        });
                        ui.label(
                            RichText::new(instrument.venue)
                                .color(GREEN)
                                .monospace()
                                .size(8.0),
                        );
                    });
                    ui.add_space(35.0);
                    ui.label(
                        RichText::new(format_price(self.engine.mid_price(), instrument))
                            .color(TEXT)
                            .monospace()
                            .size(23.0),
                    );
                    ui.label(RichText::new("+1.24%").color(GREEN).monospace().size(9.0));
                    ui.add_space(35.0);
                    metric(
                        ui,
                        "SESSION VOL",
                        &format!("{:.1}", self.engine.session_volume),
                    );
                    metric(
                        ui,
                        "CUM. DELTA",
                        &format!("{:+.1}", self.engine.cumulative_delta),
                    );
                    metric(
                        ui,
                        "IMBALANCE",
                        &format!("{:+.1}%", self.engine.imbalance() * 100.0),
                    );
                });
            });
    }

    fn controls(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let _ = ui.selectable_label(true, RichText::new("HEATMAP").monospace().size(8.0));
            let _ = ui.selectable_label(
                false,
                RichText::new("VOLUME").color(MUTED).monospace().size(8.0),
            );
            ui.separator();
            ui.checkbox(
                &mut self.heatmap.show_trades,
                RichText::new("Trades").size(8.0),
            );
            ui.add_space(8.0);
            ui.label(RichText::new("CONTRAST").color(MUTED).monospace().size(7.0));
            ui.add(
                egui::Slider::new(&mut self.heatmap.contrast, 0.55..=1.8)
                    .show_value(false)
                    .smallest_positive(0.01),
            );
            ui.label(RichText::new("PRICE").color(MUTED).monospace().size(7.0));
            ui.add(egui::Slider::new(&mut self.heatmap.zoom, 1.0..=2.5).show_value(false));
            ui.label(RichText::new("TIME").color(MUTED).monospace().size(7.0));
            ui.add(
                egui::Slider::new(&mut self.heatmap.time_zoom, 1.0..=10.0)
                    .logarithmic(true)
                    .show_value(false),
            );
            if ui.small_button("Reset").clicked() {
                self.heatmap.contrast = 1.08;
                self.heatmap.zoom = 1.0;
                self.heatmap.time_zoom = 2.5;
            }
        });
    }

    fn right_panel(&mut self, ctx: &egui::Context) {
        egui::SidePanel::right("right_panel")
            .exact_width(300.0)
            .resizable(true)
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .stroke(Stroke::new(1.0, LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut self.right_panel, RightPanel::Book, "ORDER BOOK");
                    ui.selectable_value(&mut self.right_panel, RightPanel::Trades, "TRADES");
                });
                ui.separator();
                match self.right_panel {
                    RightPanel::Book => self.book(ui),
                    RightPanel::Trades => self.trades(ui),
                }
            });
    }

    fn book(&self, ui: &mut egui::Ui) {
        let instrument = self.engine.instrument();
        egui::Grid::new("book_header")
            .num_columns(3)
            .spacing([12.0, 2.0])
            .show(ui, |ui| {
                header(ui, "BID SIZE");
                header(ui, "PRICE");
                header(ui, "ASK SIZE");
                ui.end_row();
            });
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                egui::Grid::new("book_grid")
                    .num_columns(3)
                    .striped(true)
                    .min_col_width(80.0)
                    .spacing([8.0, 2.0])
                    .show(ui, |ui| {
                        for level in &self.engine.book {
                            let bid = if level.bid_size > 0.0 {
                                format!("{:.2}", level.bid_size)
                            } else {
                                String::new()
                            };
                            let ask = if level.ask_size > 0.0 {
                                format!("{:.2}", level.ask_size)
                            } else {
                                String::new()
                            };
                            ui.label(RichText::new(bid).color(GREEN).monospace().size(9.0));
                            let color = if level.bid_size == 0.0 && level.ask_size == 0.0 {
                                YELLOW
                            } else {
                                TEXT
                            };
                            ui.label(
                                RichText::new(format_price(level.price, instrument))
                                    .color(color)
                                    .monospace()
                                    .size(9.0),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.label(RichText::new(ask).color(RED).monospace().size(9.0));
                            });
                            ui.end_row();
                        }
                    });
            });
    }

    fn trades(&self, ui: &mut egui::Ui) {
        let instrument = self.engine.instrument();
        egui::Grid::new("tape_header")
            .num_columns(3)
            .spacing([12.0, 2.0])
            .show(ui, |ui| {
                header(ui, "SEQ");
                header(ui, "PRICE");
                header(ui, "SIZE");
                ui.end_row();
            });
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                egui::Grid::new("tape_grid")
                    .num_columns(3)
                    .striped(true)
                    .min_col_width(80.0)
                    .spacing([8.0, 3.0])
                    .show(ui, |ui| {
                        for trade in &self.engine.trades {
                            let color = if trade.aggressor == Aggressor::Buy {
                                GREEN
                            } else {
                                RED
                            };
                            ui.label(
                                RichText::new(trade.sequence.to_string())
                                    .color(MUTED)
                                    .monospace()
                                    .size(8.0),
                            );
                            ui.label(
                                RichText::new(format_price(trade.price, instrument))
                                    .color(color)
                                    .monospace()
                                    .size(9.0),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.label(
                                    RichText::new(format!("{:.3}", trade.size))
                                        .color(TEXT)
                                        .monospace()
                                        .size(9.0),
                                );
                            });
                            ui.end_row();
                        }
                    });
            });
    }

    fn bottom_bar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::bottom("bottom_bar")
            .exact_height(43.0)
            .frame(
                egui::Frame::new()
                    .fill(Color32::from_rgb(8, 16, 19))
                    .stroke(Stroke::new(1.0, LINE))
                    .inner_margin(egui::Margin::symmetric(12, 7)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("●  LIVE SIMULATION")
                            .color(GREEN)
                            .monospace()
                            .size(8.0),
                    );
                    ui.add_space(12.0);
                    let label = if self.paused {
                        "▶  RESUME"
                    } else {
                        "Ⅱ  PAUSE"
                    };
                    if ui
                        .button(RichText::new(label).monospace().size(8.0))
                        .clicked()
                    {
                        self.paused = !self.paused;
                    }
                    if ui
                        .button(RichText::new("↶  RESTART").monospace().size(8.0))
                        .clicked()
                    {
                        self.engine
                            .set_instrument(INSTRUMENTS[self.selected_instrument]);
                    }
                    ui.add(
                        egui::ProgressBar::new((self.frame_count % 1000) as f32 / 1000.0)
                            .desired_width(ui.available_width() - 180.0)
                            .show_percentage(),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new("1×   UTC+8")
                                .color(MUTED)
                                .monospace()
                                .size(8.0),
                        );
                    });
                });
            });
    }
}

impl eframe::App for DepthfieldApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.frame_count += 1;
        let changed = self.engine.update(self.paused);
        if changed || !self.paused {
            ctx.request_repaint_after(Duration::from_millis(80));
        }

        self.top_bar(ctx);
        self.instrument_bar(ctx);
        self.bottom_bar(ctx);
        self.right_panel(ctx);

        egui::SidePanel::left("tools")
            .exact_width(38.0)
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .stroke(Stroke::new(1.0, LINE)),
            )
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    for tool in ["⌖", "―", "⌁", "↔", "◇", "□"] {
                        ui.add_space(5.0);
                        let _ = ui.button(RichText::new(tool).color(MUTED).monospace().size(14.0));
                    }
                });
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(BG))
            .show(ctx, |ui| {
                self.controls(ui);
                ui.separator();
                let response = heatmap::show(ui, &self.engine, &self.heatmap);
                if response.response.hovered() {
                    let (scroll, shift) =
                        ctx.input(|input| (input.raw_scroll_delta.y, input.modifiers.shift));
                    if scroll != 0.0 {
                        if shift {
                            self.heatmap.zoom =
                                (self.heatmap.zoom + scroll.signum() * 0.12).clamp(1.0, 2.5);
                        } else {
                            self.heatmap.time_zoom = (self.heatmap.time_zoom
                                * if scroll > 0.0 { 1.16 } else { 0.86 })
                            .clamp(1.0, 10.0);
                        }
                    }
                }
                let _ = response.hovered_price;
            });
    }
}

fn configure_style(ctx: &egui::Context) {
    let mut style = (*ctx.style()).clone();
    style.visuals.dark_mode = true;
    style.visuals.panel_fill = PANEL;
    style.visuals.window_fill = PANEL_2;
    style.visuals.extreme_bg_color = BG;
    style.visuals.faint_bg_color = Color32::from_rgb(14, 25, 30);
    style.visuals.widgets.inactive.bg_fill = PANEL_2;
    style.visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, LINE);
    style.visuals.widgets.hovered.bg_fill = Color32::from_rgb(18, 38, 42);
    style.visuals.widgets.active.bg_fill = Color32::from_rgb(16, 49, 46);
    style.visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(36, 208, 171, 45);
    style.visuals.selection.stroke = Stroke::new(1.0, GREEN);
    style.spacing.item_spacing = Vec2::new(8.0, 5.0);
    style.text_styles.insert(
        egui::TextStyle::Body,
        FontId::new(10.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Button,
        FontId::new(9.0, FontFamily::Proportional),
    );
    ctx.set_style(style);
}

fn metric(ui: &mut egui::Ui, name: &str, value: &str) {
    ui.vertical(|ui| {
        ui.label(RichText::new(name).color(MUTED).monospace().size(7.0));
        ui.label(RichText::new(value).color(TEXT).monospace().size(10.0));
    });
}

fn header(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).color(MUTED).monospace().size(7.0));
}

#[allow(dead_code)]
fn _instrument_label(instrument: Instrument) -> String {
    format!("{} · {}", instrument.symbol, instrument.venue)
}
