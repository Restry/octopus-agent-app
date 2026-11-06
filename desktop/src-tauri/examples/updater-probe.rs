// Runs the actual updater against a caller-owned loopback fixture. Never installs or restarts.
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;
fn main() {
    let endpoint = std::env::var("OCTOPUS_PROBE_ENDPOINT").expect("probe endpoint required");
    assert!(endpoint.starts_with("http://127.0.0.1:"), "loopback fixture only");
    let pubkey = std::fs::read_to_string(std::env::var("OCTOPUS_PROBE_PUBLIC_KEY").unwrap()).unwrap();
    let mut context = tauri::generate_context!();
    context.package_info_mut().version = "0.1.0".parse().unwrap();
    context.config_mut().app.windows.clear();
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({"pubkey":pubkey.trim(),"dangerousInsecureTransportProtocol":true}));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .expect("probe app context");
    let updater = app.updater_builder()
        .endpoints(vec![endpoint.parse().unwrap()]).unwrap()
        .target("darwin-aarch64")
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build().unwrap();
    tauri::async_runtime::block_on(async {
        let update = updater.check().await.expect("official updater check").expect("newer version must exist");
        println!("discovered version={}",update.version);
        let mut received = 0;
        match update.download(|count,_| received += count, || {}).await {
            Ok(bytes) => { println!("accepted signed bytes={}",bytes.len()); assert!(std::env::var("OCTOPUS_PROBE_REJECT").is_err(),"wrong signature accepted"); }
            Err(error) => { assert!(std::env::var("OCTOPUS_PROBE_REJECT").is_ok(),"valid signature rejected: {error}"); let reason=error.to_string(); assert!(reason.to_lowercase().contains("signature") || reason.to_lowercase().contains("verify"),"non-signature failure: {reason}"); println!("rejected wrong signature: {reason}"); }
        }
        assert!(received > 0);
    });
}
