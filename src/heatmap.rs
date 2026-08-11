use eframe::egui::{
    self, Align2, Color32, FontId, Pos2, Rect, Response, Sense, Shape, Stroke, StrokeKind, Ui, Vec2,
};

use crate::market::{Aggressor, DEPTH_ROWS, MarketEngine, format_price};

pub struct HeatmapSettings {
    pub contrast: f32,
    pub zoom: f32,
    pub time_zoom: f32,
    pub show_trades: bool,
}

pub struct HeatmapResponse {
    pub response: Response,
    pub hovered_price: Option<f64>,
}

pub fn show(ui: &mut Ui, engine: &MarketEngine, settings: &HeatmapSettings) -> HeatmapResponse {
    let desired = Vec2::new(ui.available_width(), ui.available_height().max(300.0));
    let (response, painter) = ui.allocate_painter(desired, Sense::click_and_drag());
    let rect = response.rect;
    painter.rect_filled(rect, 0.0, Color32::from_rgb(3, 9, 14));

    let axis_width = 76.0;
    let time_height = 20.0;
    let plot = Rect::from_min_max(
        rect.min,
        Pos2::new(rect.right() - axis_width, rect.bottom() - time_height),
    );
    let live_width = 86.0_f32.min(plot.width() * 0.14);
    let now_x = plot.right() - live_width;
    let history_plot = Rect::from_min_max(plot.min, Pos2::new(now_x, plot.bottom()));
    let live_plot = Rect::from_min_max(
        Pos2::new(now_x, plot.top()),
        Pos2::new(plot.right(), plot.bottom()),
    );
    let axis = Rect::from_min_max(Pos2::new(plot.right(), rect.top()), rect.max);
    painter.rect_filled(axis, 0.0, Color32::from_rgb(6, 13, 18));
    painter.line_segment(
        [
            Pos2::new(plot.right(), plot.top()),
            Pos2::new(plot.right(), rect.bottom()),
        ],
        Stroke::new(1.0, Color32::from_rgb(31, 46, 53)),
    );

    let visible_columns = ((engine.history.len() as f32 / settings.time_zoom).round() as usize)
        .clamp(30, engine.history.len().max(30));
    let skip_columns = engine.history.len().saturating_sub(visible_columns);
    let history: Vec<_> = engine.history.iter().skip(skip_columns).collect();
    let columns = history.len().max(1);
    let visible_rows = (58.0 / settings.zoom.sqrt()).clamp(28.0, DEPTH_ROWS as f32);
    let cell_width = history_plot.width() / columns as f32;
    let cell_height = plot.height() / visible_rows;
    let tick = engine.instrument().tick_size;
    let current_mid = engine.mid_price();
    for (column_index, column) in history.iter().enumerate() {
        let x = history_plot.left() + column_index as f32 * cell_width;
        let age_fade = 0.74 + 0.26 * column_index as f32 / columns as f32;
        for row in 0..DEPTH_ROWS {
            let price = engine.anchor_price() + (DEPTH_ROWS as f64 / 2.0 - row as f64) * tick;
            let y = plot.center().y - ((price - current_mid) / tick) as f32 * cell_height;
            if y + cell_height < plot.top() || y > plot.bottom() {
                continue;
            }
            let raw = column.liquidity[row];
            let value = (raw * settings.contrast).clamp(0.0, 1.0).powf(0.82);
            let cell = Rect::from_min_size(
                Pos2::new(x, y - cell_height * 0.5),
                Vec2::new(cell_width + 0.75, cell_height + 0.45),
            )
            .intersect(history_plot);
            painter.rect_filled(cell, 0.0, liquidity_color(value, age_fade));
        }
    }

    painter.rect_filled(
        live_plot,
        0.0,
        Color32::from_rgba_unmultiplied(7, 20, 27, 165),
    );
    for row in 0..DEPTH_ROWS {
        let price = engine.anchor_price() + (DEPTH_ROWS as f64 / 2.0 - row as f64) * tick;
        let y = plot.center().y - ((price - current_mid) / tick) as f32 * cell_height;
        if y + cell_height < live_plot.top() || y > live_plot.bottom() {
            continue;
        }
        let value = (engine.current_liquidity()[row] * settings.contrast)
            .clamp(0.0, 1.0)
            .powf(0.82);
        painter.rect_filled(
            Rect::from_min_size(
                Pos2::new(live_plot.left(), y - cell_height * 0.5),
                Vec2::new(live_plot.width(), cell_height + 0.45),
            )
            .intersect(live_plot),
            0.0,
            liquidity_color(value, 1.0),
        );
    }
    painter.line_segment(
        [
            Pos2::new(now_x, history_plot.top()),
            Pos2::new(now_x, history_plot.bottom()),
        ],
        Stroke::new(1.25, Color32::from_rgba_unmultiplied(222, 236, 233, 190)),
    );
    painter.text(
        Pos2::new(now_x + 5.0, history_plot.top() + 9.0),
        Align2::LEFT_TOP,
        "LIVE BOOK",
        FontId::monospace(7.0),
        Color32::from_rgb(37, 208, 171),
    );

    let horizontal_step = if settings.zoom > 1.7 { 2 } else { 5 };
    let half_rows = (visible_rows / 2.0).ceil() as i32;
    for offset in -half_rows..=half_rows {
        if offset % horizontal_step != 0 {
            continue;
        }
        let y = plot.center().y - offset as f32 * cell_height;
        if !plot.y_range().contains(y) {
            continue;
        }
        painter.line_segment(
            [Pos2::new(plot.left(), y), Pos2::new(plot.right(), y)],
            Stroke::new(0.55, Color32::from_white_alpha(20)),
        );
        let price = current_mid + offset as f64 * tick;
        painter.text(
            Pos2::new(plot.right() + 8.0, y),
            Align2::LEFT_CENTER,
            format_price(price, engine.instrument()),
            FontId::monospace(9.0),
            Color32::from_rgb(112, 136, 143),
        );
    }

    for fraction in [0.2_f32, 0.4, 0.6, 0.8] {
        let x = egui::lerp(history_plot.x_range(), fraction);
        painter.line_segment(
            [Pos2::new(x, plot.top()), Pos2::new(x, plot.bottom())],
            Stroke::new(0.65, Color32::from_white_alpha(22)),
        );
        let span_seconds = columns as f32 * 0.095;
        let seconds_ago = ((1.0 - fraction) * span_seconds).round() as i32;
        painter.text(
            Pos2::new(x, plot.bottom() + 11.0),
            Align2::CENTER_CENTER,
            format!("-{seconds_ago}s"),
            FontId::monospace(8.0),
            Color32::from_rgb(88, 109, 116),
        );
    }
    painter.text(
        Pos2::new(now_x - 3.0, plot.bottom() + 11.0),
        Align2::RIGHT_CENTER,
        "NOW",
        FontId::monospace(8.0),
        Color32::from_rgb(34, 208, 171),
    );

    let mut price_path = Vec::with_capacity(columns);
    for (column_index, column) in history.iter().enumerate() {
        let x = history_plot.left() + column_index as f32 * cell_width + cell_width * 0.5;
        let y = plot.center().y - ((column.mid_price - current_mid) / tick) as f32 * cell_height;
        if plot.contains(Pos2::new(x, y)) {
            price_path.push(Pos2::new(x, y));
        }
    }
    if price_path.len() > 1 {
        painter.add(Shape::line(
            price_path.clone(),
            Stroke::new(3.2, Color32::from_rgba_unmultiplied(4, 12, 16, 150)),
        ));
        painter.add(Shape::line(
            price_path,
            Stroke::new(1.15, Color32::from_rgb(226, 239, 236)),
        ));
    }

    let candle_span = 6;
    for start in (0..history.len()).step_by(candle_span) {
        let end = (start + candle_span).min(history.len());
        let candle = &history[start..end];
        if candle.is_empty() {
            continue;
        }
        let open = candle.first().unwrap().mid_price;
        let close = candle.last().unwrap().mid_price;
        let high = candle
            .iter()
            .map(|column| column.mid_price)
            .fold(f64::NEG_INFINITY, f64::max)
            + tick * 0.55;
        let low = candle
            .iter()
            .map(|column| column.mid_price)
            .fold(f64::INFINITY, f64::min)
            - tick * 0.55;
        let x = history_plot.left() + (start as f32 + candle.len() as f32 * 0.5) * cell_width;
        let price_to_y =
            |price: f64| plot.center().y - ((price - current_mid) / tick) as f32 * cell_height;
        let high_y = price_to_y(high);
        let low_y = price_to_y(low);
        if low_y < plot.top() || high_y > plot.bottom() {
            continue;
        }
        let fill = if close >= open {
            Color32::from_rgb(22, 213, 82)
        } else {
            Color32::from_rgb(244, 52, 61)
        };
        painter.line_segment(
            [Pos2::new(x, high_y), Pos2::new(x, low_y)],
            Stroke::new(1.1, Color32::from_rgb(236, 243, 241)),
        );
        let open_y = price_to_y(open);
        let close_y = price_to_y(close);
        let body_width = (cell_width * candle.len() as f32 * 0.72).max(3.5);
        let body = Rect::from_min_max(
            Pos2::new(x - body_width * 0.5, open_y.min(close_y) - 1.2),
            Pos2::new(x + body_width * 0.5, open_y.max(close_y) + 1.2),
        )
        .intersect(history_plot);
        painter.rect_filled(body, 0.0, fill);
        painter.rect_stroke(
            body,
            0.0,
            Stroke::new(1.0, Color32::from_rgb(239, 245, 243)),
            StrokeKind::Inside,
        );

        let buy_volume: f64 = candle
            .iter()
            .flat_map(|column| &column.trades)
            .filter(|trade| trade.aggressor == Aggressor::Buy)
            .map(|trade| trade.size)
            .sum();
        let sell_volume: f64 = candle
            .iter()
            .flat_map(|column| &column.trades)
            .filter(|trade| trade.aggressor == Aggressor::Sell)
            .map(|trade| trade.size)
            .sum();
        let total = buy_volume + sell_volume;
        if total > 0.0 {
            let volume_height = (4.0 + total.sqrt() as f32 * 8.0).clamp(4.0, 34.0);
            let volume_color = if buy_volume >= sell_volume {
                Color32::from_rgba_unmultiplied(30, 218, 123, 190)
            } else {
                Color32::from_rgba_unmultiplied(248, 64, 78, 190)
            };
            painter.rect_filled(
                Rect::from_min_size(
                    Pos2::new(x - body_width * 0.42, history_plot.bottom() - volume_height),
                    Vec2::new(body_width * 0.84, volume_height),
                ),
                0.0,
                volume_color,
            );
        }
    }

    if settings.show_trades {
        for (column_index, column) in history.iter().enumerate() {
            let x = history_plot.left() + column_index as f32 * cell_width + cell_width * 0.5;
            for trade in &column.trades {
                let y = plot.center().y - ((trade.price - current_mid) / tick) as f32 * cell_height;
                if !plot.contains(Pos2::new(x, y)) {
                    continue;
                }
                let radius = (1.7 + trade.size.sqrt() as f32 * 2.0).clamp(1.7, 6.2);
                let (fill, edge) = match trade.aggressor {
                    Aggressor::Buy => (
                        Color32::from_rgba_unmultiplied(39, 222, 151, 205),
                        Color32::from_rgb(152, 255, 211),
                    ),
                    Aggressor::Sell => (
                        Color32::from_rgba_unmultiplied(255, 76, 103, 210),
                        Color32::from_rgb(255, 167, 181),
                    ),
                };
                painter.circle_filled(Pos2::new(x, y), radius, fill);
                painter.circle_stroke(Pos2::new(x, y), radius, Stroke::new(0.75, edge));
            }
        }
    }

    let current_y = plot.center().y;
    painter.line_segment(
        [
            Pos2::new(plot.left(), current_y),
            Pos2::new(plot.right(), current_y),
        ],
        Stroke::new(0.85, Color32::from_rgba_unmultiplied(230, 242, 239, 165)),
    );
    let price_badge = Rect::from_min_size(
        Pos2::new(plot.right(), current_y - 10.0),
        Vec2::new(axis_width, 20.0),
    );
    painter.rect_filled(price_badge, 0.0, Color32::from_rgb(26, 177, 143));
    painter.text(
        price_badge.center(),
        Align2::CENTER_CENTER,
        format_price(current_mid, engine.instrument()),
        FontId::monospace(9.5),
        Color32::from_rgb(3, 17, 14),
    );

    painter.text(
        Pos2::new(plot.left() + 9.0, plot.top() + 9.0),
        Align2::LEFT_TOP,
        "LIQUIDITY · HISTORICAL DEPTH",
        FontId::monospace(7.5),
        Color32::from_rgba_unmultiplied(149, 173, 178, 125),
    );

    let mut hovered_price = None;
    if let Some(pointer) = response.hover_pos().filter(|point| plot.contains(*point)) {
        painter.line_segment(
            [
                Pos2::new(pointer.x, plot.top()),
                Pos2::new(pointer.x, plot.bottom()),
            ],
            Stroke::new(0.7, Color32::from_white_alpha(120)),
        );
        painter.line_segment(
            [
                Pos2::new(plot.left(), pointer.y),
                Pos2::new(plot.right(), pointer.y),
            ],
            Stroke::new(0.7, Color32::from_white_alpha(120)),
        );
        let rows_from_mid = (plot.center().y - pointer.y) / cell_height;
        let price = current_mid + rows_from_mid as f64 * tick;
        hovered_price = Some(price);
        let label_rect = Rect::from_min_size(
            Pos2::new(plot.right(), pointer.y - 10.0),
            Vec2::new(axis_width, 20.0),
        );
        painter.rect_filled(
            label_rect,
            0.0,
            Color32::from_rgba_unmultiplied(12, 26, 31, 245),
        );
        painter.rect_stroke(
            label_rect,
            0.0,
            Stroke::new(0.8, Color32::from_rgb(81, 108, 113)),
            StrokeKind::Inside,
        );
        painter.text(
            label_rect.center(),
            Align2::CENTER_CENTER,
            format_price(price, engine.instrument()),
            FontId::monospace(9.0),
            Color32::from_rgb(218, 231, 230),
        );
    }

    HeatmapResponse {
        response,
        hovered_price,
    }
}

fn liquidity_color(value: f32, fade: f32) -> Color32 {
    let (r, g, b, alpha) = if value < 0.12 {
        (4, 22, 39, 118.0 + value * 300.0)
    } else if value < 0.32 {
        let t = (value - 0.12) / 0.20;
        (4, (38.0 + t * 58.0) as u8, (68.0 + t * 76.0) as u8, 150.0)
    } else if value < 0.56 {
        let t = (value - 0.32) / 0.24;
        (
            (4.0 + t * 20.0) as u8,
            (100.0 + t * 82.0) as u8,
            (145.0 - t * 28.0) as u8,
            186.0,
        )
    } else if value < 0.78 {
        let t = (value - 0.56) / 0.22;
        (
            (25.0 + t * 183.0) as u8,
            (182.0 + t * 27.0) as u8,
            (118.0 - t * 60.0) as u8,
            220.0,
        )
    } else if value < 0.94 {
        let t = ((value - 0.78) / 0.22).clamp(0.0, 1.0);
        (
            239,
            (205.0 - t * 62.0) as u8,
            (65.0 - t * 31.0) as u8,
            242.0,
        )
    } else {
        (244, 63, 39, 250.0)
    };
    Color32::from_rgba_unmultiplied(r, g, b, (alpha * fade).clamp(0.0, 255.0) as u8)
}
