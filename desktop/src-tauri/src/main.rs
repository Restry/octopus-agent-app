#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
};
use tauri::{ipc::Channel, LogicalPosition, LogicalSize, Manager, State};
#[derive(Serialize, Deserialize, Clone)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
}
struct Desktop {
    child: Mutex<Option<Child>>,
    token: String,
    geometry: Mutex<Geometry>,
    file: PathBuf,
    pet_height: Mutex<f64>,
}
#[tauri::command]
async fn agent_request(
    command: String,
    args: Value,
    on_event: Channel<Value>,
    state: State<'_, Desktop>,
) -> Result<Value, String> {
    if !command.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        return Err("无效请求".into());
    }
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:43917/api/{command}"))
        .bearer_auth(&state.token)
        .json(&args)
        .send()
        .await
        .map_err(|_| "本机服务尚未就绪")?;
    if !response.status().is_success() {
        let data: Value = response.json().await.unwrap_or_default();
        return Err(data["error"].as_str().unwrap_or("本地请求失败").into());
    }
    if command != "agent_run" {
        return Ok(response.json::<Value>().await.map_err(|_| "无效响应")?["result"].clone());
    }
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut reply = None;
    while let Some(chunk) = stream.next().await {
        pending.extend_from_slice(&chunk.map_err(|_| "回复已断开，请恢复会话")?);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = pending.drain(..=end).collect();
            let event: Value = serde_json::from_slice(&line).map_err(|_| "流式数据无效")?;
            if event["type"] == "done" {
                reply = Some(event["result"].clone());
            } else if event["type"] == "error" {
                return Err(event["error"].as_str().unwrap_or("任务失败，请恢复会话").into());
            } else {
                let _ = on_event.send(event);
            }
        }
    }
    reply.ok_or("回复未完成，请恢复会话".into())
}
#[tauri::command]
fn desktop_cursor(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let p = window.cursor_position().map_err(|e| e.to_string())?;
    let o = window.outer_position().map_err(|e| e.to_string())?;
    let s = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(((p.x - o.x as f64) / s, (p.y - o.y as f64) / s))
}
#[tauri::command]
fn desktop_ignore(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn desktop_layout(
    window: tauri::WebviewWindow,
    state: State<Desktop>,
    mode: String,
    width: Option<f64>,
    creature_height: Option<f64>,
    capture: bool,
) -> Result<Value, String> {
    let mut g = state.geometry.lock();
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("无屏幕")?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let left = work.position.x as f64 / scale;
    let top = work.position.y as f64 / scale;
    let mw = work.size.width as f64 / scale;
    let mh = work.size.height as f64 / scale;
    if capture {
        let p = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        g.x = p.x as f64 / scale + (size.width as f64 / scale - g.width) / 2.;
        g.y = p.y as f64 / scale + size.height as f64 / scale - *state.pet_height.lock();
    }
    if let Some(w) = width {
        if w.is_finite() {
            g.width = w.clamp(180., 400.).min(mw);
        }
    }
    let units = creature_height.filter(|h| h.is_finite()).unwrap_or(174.).max(174.);
    let pet_h = (g.width * units / 280. + 26.).min(mh * 0.55);
    *state.pet_height.lock() = pet_h;
    let (w, h) = if mode == "compact" {
        (g.width, pet_h)
    } else {
        (440_f64.min(mw), (pet_h + 520.).min(mh))
    };
    let x = (g.x - (w - g.width) / 2.).clamp(left, (left + mw - w).max(left));
    let y = (g.y - (h - pet_h)).clamp(top, (top + mh - h).max(top));
    window
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    g.x = x + (w - g.width) / 2.;
    g.y = y + h - pet_h;
    if let Ok(text) = serde_json::to_vec(&*g) {
        let _ = std::fs::write(&state.file, text);
    }
    Ok(serde_json::json!({"x":g.x,"y":g.y,"width":g.width,"petHeight":pet_h}))
}
#[tauri::command]
fn desktop_probe(window: tauri::WebviewWindow) -> Result<Value, String> {
    Ok(
        serde_json::json!({"position":window.outer_position().map_err(|e|e.to_string())?,"size":window.inner_size().map_err(|e|e.to_string())?,"scale":window.scale_factor().map_err(|e|e.to_string())?,"decorated":window.is_decorated().map_err(|e|e.to_string())?,"resizable":window.is_resizable().map_err(|e|e.to_string())?}),
    )
}
#[tauri::command]
fn desktop_report(name: String, data: Value) {
    if cfg!(debug_assertions) {
        eprintln!("NATIVE_EVIDENCE {} {}", name, data);
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_page_load(|window, payload| {
            if cfg!(debug_assertions)
                && std::env::var("OCTOPUS_SMOKE").is_ok()
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let _ = window.eval(include_str!("../../../scripts/native-smoke.js"));
            }
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let file = data.join("window.json");
            let geometry = std::fs::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Geometry>(&b).ok())
                .filter(|g| g.x.is_finite() && g.y.is_finite() && g.width.is_finite())
                .unwrap_or(Geometry {
                    x: 500.,
                    y: 600.,
                    width: 280.,
                });
            let runtime = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            let node = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/node")
            } else {
                runtime.join("node")
            };
            if std::net::TcpStream::connect("127.0.0.1:43917").is_ok() {
                return Err("43917 端口已占用，请先关闭另一个章鱼实例".into());
            }
            let mut bytes = [0u8; 32];
            std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
            let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let mut child = Command::new(node)
                .arg(runtime.join("scripts/server.mjs"))
                .current_dir(&runtime)
                .env("OCTOPUS_BRIDGE_TOKEN", &token)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()?;
            let mut ready = false;
            for _ in 0..300 {
                if child.try_wait()?.is_some() {
                    return Err("独立服务启动失败".into());
                }
                if std::net::TcpStream::connect("127.0.0.1:43917").is_ok() {
                    ready = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if !ready {
                let _ = child.kill();
                let _ = child.wait();
                return Err("独立服务启动超时".into());
            }
            app.manage(Desktop {
                child: Mutex::new(Some(child)),
                token,
                geometry: Mutex::new(geometry),
                file,
                pet_height: Mutex::new(200.),
            });
            let window = app.get_webview_window("main").unwrap();
            desktop_layout(window.clone(), app.state(), "compact".into(), None, None, false)
                .map_err(std::io::Error::other)?;
            window.show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_request,
            desktop_cursor,
            desktop_ignore,
            desktop_layout,
            desktop_probe,
            desktop_report
        ])
        .build(tauri::generate_context!())
        .expect("原生窗口启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Desktop>().child.lock().take() {
                    // Let the service close its stdio MCP children before the fallback kill.
                    let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
                    while child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
