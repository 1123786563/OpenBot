use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State, Url, WebviewUrl, WebviewWindowBuilder};

// No static or dynamic capability targets these labels.
const WINDOW_PREFIX: &str = "cloud-connection-";
const RECORD: &str = "cloud-origin.json";
const INVALID_ORIGIN: &str = "Enter an HTTPS address such as https://openbot.example.com, without a path, query, or fragment.";

#[derive(Default)]
pub struct CloudConnection(Mutex<Windows>);

#[derive(Default)]
struct Windows {
    next_id: u64,
    active: Option<(String, Url)>,
}

pub fn is_cloud_window(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
}

pub fn protect_ipc<R: Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool {
    move |invoke| {
        if is_cloud_window(invoke.message.webview_ref().label()) {
            invoke
                .resolver
                .reject("Cloud windows have no Desktop permissions.");
            return true;
        }
        handler(invoke)
    }
}

fn cloud_navigation(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            !matches!(
                host.trim_end_matches('.'),
                "tauri.localhost" | "asset.localhost" | "ipc.localhost"
            )
        })
        && url.username().is_empty()
        && url.password().is_none()
}

fn cloud_origin(address: &str) -> Result<Url, &'static str> {
    let url = Url::parse(address.trim()).map_err(|_| INVALID_ORIGIN)?;
    if !cloud_navigation(&url)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(INVALID_ORIGIN);
    }
    Ok(url)
}

fn directory<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| error.to_string())
}

fn read_origin(dir: &std::path::Path) -> Result<Option<Url>, String> {
    match std::fs::read(dir.join(RECORD)) {
        Ok(bytes) => {
            let address: String = serde_json::from_slice(&bytes)
                .map_err(|_| "The saved OpenBot Cloud address is invalid.")?;
            cloud_origin(&address).map(Some).map_err(str::to_owned)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the saved cloud address: {error}")),
    }
}

fn write_origin(dir: &std::path::Path, origin: &str) -> Result<(), String> {
    let temporary = dir.join("cloud-origin.json.tmp");
    let bytes = serde_json::to_vec(origin).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, dir.join(RECORD)).map_err(|error| error.to_string())
}

pub fn has_saved_connection<R: Runtime>(app: &AppHandle<R>) -> bool {
    directory(app).is_ok_and(|dir| dir.join(RECORD).exists())
}

#[tauri::command]
pub async fn saved_cloud_origin(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_origin(&directory(&app)?)?.map(|url| url.origin().ascii_serialization()))
}

#[tauri::command]
pub async fn open_cloud(
    app: AppHandle,
    state: State<'_, CloudConnection>,
    origin: String,
) -> Result<String, String> {
    let url = cloud_origin(&origin)?;
    let origin = url.origin().ascii_serialization();
    let mut windows = state.0.lock().unwrap();
    let previous = windows.active.as_ref().and_then(|(label, current)| {
        app.get_webview_window(label)
            .map(|window| (window, current))
    });
    if let Some((window, _)) = previous.as_ref().filter(|(_, current)| **current == url) {
        window.navigate(url).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(origin);
    }

    let dir = directory(&app)?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    if let Some((previous, _)) = previous {
        previous.destroy().map_err(|error| error.to_string())?;
    }
    windows.active = None;

    // A destroyed window may still have pending events. Never reuse its label.
    let label = format!("{WINDOW_PREFIX}{}", windows.next_id);
    windows.next_id += 1;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
        .title(format!("OpenBot Cloud — {origin}"))
        .inner_size(1000.0, 800.0)
        .min_inner_size(720.0, 560.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .visible(false)
        .on_navigation(cloud_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|error| error.to_string())?;

    let opened = window.show().and_then(|()| window.set_focus());
    let saved = opened.map_err(|error| error.to_string()).and_then(|()| {
        write_origin(&dir, &origin)
            .map_err(|error| format!("Could not save the cloud address: {error}"))
    });
    if let Err(error) = saved {
        let _ = window.destroy();
        return Err(error);
    }
    windows.active = Some((label, url));
    Ok(origin)
}

#[tauri::command]
pub async fn disconnect_cloud(
    app: AppHandle,
    state: State<'_, CloudConnection>,
) -> Result<(), String> {
    let mut windows = state.0.lock().unwrap();
    if let Some((label, _)) = &windows.active {
        if let Some(window) = app.get_webview_window(label) {
            window.destroy().map_err(|error| error.to_string())?;
        }
        windows.active = None;
    }
    match std::fs::remove_file(directory(&app)?.join(RECORD)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not forget the cloud address: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replaced_address_is_reopened_and_a_malformed_record_is_recoverable() {
        let dir = crate::test_support::temp_root("cloud-origin");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_origin(&dir).unwrap(), None);
        write_origin(&dir, "https://first.example").unwrap();
        write_origin(&dir, "https://second.example:8443").unwrap();
        assert_eq!(
            read_origin(&dir).unwrap().unwrap().as_str(),
            "https://second.example:8443/"
        );
        std::fs::write(dir.join(RECORD), r#""http://second.example""#).unwrap();
        assert!(read_origin(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_https_origins_and_normalizes_the_saved_address() {
        assert_eq!(
            cloud_origin("  https://OPENBOT.example:443/  ")
                .unwrap()
                .as_str(),
            "https://openbot.example/"
        );
        assert_eq!(
            cloud_origin("https://localhost:18443").unwrap().as_str(),
            "https://localhost:18443/"
        );
    }

    #[test]
    fn rejects_http_and_addresses_that_are_not_origins() {
        for input in [
            "http://localhost:18443",
            "tauri://localhost",
            "https://tauri.localhost",
            "https://someone:password@openbot.example",
            "https://openbot.example/login",
            "https://openbot.example/?code=123",
            "https://openbot.example/#home",
        ] {
            assert!(cloud_origin(input).is_err(), "{input}");
        }
    }

    #[test]
    fn navigation_allows_an_https_identity_provider_and_callback() {
        for address in [
            "https://login.example/realms/openbot",
            "https://openbot.example/api/auth/callback/okta?code=123",
        ] {
            assert!(cloud_navigation(&Url::parse(address).unwrap()));
        }
        for address in [
            "http://127.0.0.1:18444/",
            "openbot://callback",
            "file:///Users/someone/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(!cloud_navigation(&Url::parse(address).unwrap()));
        }
    }
}
