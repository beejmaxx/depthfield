mod app;
mod heatmap;
mod market;

use app::DepthfieldApp;
use eframe::egui;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        viewport: egui::ViewportBuilder::default()
            .with_title("Depthfield — Market Depth Workstation")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([980.0, 640.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Depthfield",
        options,
        Box::new(|cc| Ok(Box::new(DepthfieldApp::new(cc)))),
    )
}
