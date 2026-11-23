use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::TryRngCore;
use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, Url, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

const CLIENT: &str = "desktop";
const RETURN_URI: &str = "openbot://auth/personal-saas";
const WINDOW: &str = "personal-cloud";
pub const MENU_LABEL: &str = "OpenBot Cloud…";
pub const MENU_ID: &str = "personal-cloud";
const STORE_SERVICE: &str = "ai.copilotkit.openbot.desktop.personal-cloud";
const ATTEMPT_TTL: Duration = Duration::from_secs(600);
const NETWORK_ERROR: &str = "Could not reach OpenBot Cloud. Try again.";
const STORE_ERROR: &str = "Could not access your system credential store. Unlock it and try again.";

fn parse_origin(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub fn is_return_uri(url: &Url) -> bool {
    let mut base = url.clone();
    base.set_query(None);
    base.set_fragment(None);
    base.as_str() == RETURN_URI
}

struct Attempt {
    state: String,
    verifier: String,
    started: Instant,
}

impl Attempt {
    fn new(origin: &Url) -> Result<(Self, Url), &'static str> {
        fn random_parameter() -> Result<String, &'static str> {
            let mut bytes = [0; 32];
            rand::rngs::OsRng
                .try_fill_bytes(&mut bytes)
                .map_err(|_| "Could not initialize browser sign-in. Try again.")?;
            Ok(URL_SAFE_NO_PAD.encode(bytes))
        }
        let state = random_parameter()?;
        let verifier = random_parameter()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut start = endpoint(origin, "/auth/native/start");
        start.query_pairs_mut().extend_pairs([
            ("client", CLIENT),
            ("state", &state),
            ("code_challenge", &challenge),
        ]);
        Ok((
            Self {
                state,
                verifier,
                started: Instant::now(),
            },
            start,
        ))
    }

    fn result(&self, link: &Url) -> Option<Return> {
        if !is_return_uri(link) || link.fragment().is_some() || self.expired() {
            return None;
        }
        let mut state = None;
        let mut outcome = None;
        for (key, value) in link.query_pairs() {
            match key.as_ref() {
                "state" if state.is_none() => state = Some(value),
                "code" if outcome.is_none() && !value.is_empty() => {
                    outcome = Some(Return::Code(value.into_owned()));
                }
                "error" if outcome.is_none() => {
                    let failure = match value.as_ref() {
                        "email_unverified" => SignInFailure::EmailUnverified,
                        "account_unavailable" => SignInFailure::AccountUnavailable,
                        _ => SignInFailure::Incomplete,
                    };
                    outcome = Some(Return::Failed(failure));
                }
                _ => return None,
            }
        }
        (state.as_deref() == Some(self.state.as_str()))
            .then_some(outcome)
            .flatten()
    }

    fn expired(&self) -> bool {
        self.started.elapsed() >= ATTEMPT_TTL
    }
}

enum Return {
    Code(String),
    Failed(SignInFailure),
}

#[derive(Clone, Copy)]
enum SignInFailure {
    Incomplete,
    EmailUnverified,
    AccountUnavailable,
    StoreUnavailable,
}

impl SignInFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Incomplete => "Sign-in did not finish. Try again.",
            Self::EmailUnverified => "Verify your email address, then try signing in again.",
            Self::AccountUnavailable => {
                "This account is unavailable. Try signing in with another account."
            }
            Self::StoreUnavailable => STORE_ERROR,
        }
    }
}

#[derive(Default)]
enum SignIn {
    #[default]
    Idle,
    Waiting(Attempt),
    Failed(SignInFailure),
    Paused(PausedWorkspace),
    Closed(ClosedWorkspace),
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Status,
    Start,
    Cancel,
    Prepare,
    SignOut,
    Closure,
    Export,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum View {
    Unavailable,
    SignedOut,
    Waiting,
    SignInFailed { message: &'static str },
    Preparing,
    AdmissionsPaused,
    Paused(PausedWorkspace),
    Closed(ClosedWorkspace),
    Workspace(Box<WorkspaceView>),
}

#[derive(Serialize)]
pub struct WorkspaceView {
    id: String,
    #[serde(rename = "personalAssistant")]
    personal_assistant: Assistant,
    conversations: Vec<Conversation>,
    #[serde(rename = "accessMs")]
    access_ms: u64,
    quotas: Option<WorkspaceQuotas>,
    #[serde(rename = "testCredits")]
    test_credits: Option<TestCredits>,
    recovery: Vec<StoppedWork>,
    #[serde(rename = "recoveryCanRetry")]
    recovery_can_retry: bool,
    #[serde(flatten)]
    workspace_recovery: WorkspaceRecovery,
}

#[derive(Deserialize, Serialize)]
pub struct Assistant {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    personal_assistant: Assistant,
    quotas: Option<WorkspaceQuotas>,
    test_credits: Option<TestCredits>,
    #[serde(default)]
    recovery: Vec<StoppedWork>,
    #[serde(default)]
    recovery_can_retry: bool,
    #[serde(flatten)]
    workspace_recovery: WorkspaceRecovery,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCredits {
    state: TestCreditState,
    amount_microcredits: String,
    balance: TestCreditBalance,
    used_up: bool,
    quote: Option<TestCreditQuote>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestCreditQuote {
    #[serde(flatten)]
    reference: TestCreditQuoteRef,
    model: String,
    price: TestCreditPrice,
    max_charge_microcredits: String,
    usage_disclosure: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestCreditPrice {
    input_per_million: u64,
    output_per_million: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum TestCreditState {
    Pending,
    Issued,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestCreditBalance {
    available_microcredits: String,
}

#[derive(Deserialize, Serialize)]
pub struct WorkspaceQuotas {
    bot: QuotaUsage,
    computer: QuotaUsage,
    storage: QuotaUsage,
    automation: QuotaUsage,
}

#[derive(Deserialize, Serialize)]
struct QuotaUsage {
    used: Option<u64>,
    limit: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecovery {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    interrupted_background_work: Vec<InterruptedBackgroundWork>,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation: Option<WorkspaceAutomation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    invalidated_approvals: Vec<InvalidatedApproval>,
    #[serde(default)]
    computer: Option<WorkspaceComputer>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InterruptedBackgroundWork {
    label: String,
    summary: Option<String>,
    recovery_can_retry: bool,
    #[serde(flatten)]
    interruption: WorkInterruption,
}

#[derive(Deserialize, Serialize)]
struct WorkspaceComputer {
    status: ComputerStatus,
    cutoff: Option<ComputerCutoff>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ComputerStatus {
    NotStarted,
    Starting,
    Running,
    Stopping,
    RestartRequired,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ComputerCutoff {
    Confirmed,
    Failed,
}

#[derive(Deserialize, Serialize)]
struct WorkspaceAutomation {
    routines: Vec<WorkspaceRoutine>,
    bindings: Vec<WorkspaceBinding>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRoutine {
    id: String,
    title: Option<String>,
    enabled: bool,
    blocked_reason: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBinding {
    id: String,
    transport: String,
    blocked_reason: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct InvalidatedApproval {
    id: String,
    tool: String,
}

#[derive(Deserialize, Serialize)]
pub struct AutomationHistory {
    runs: Vec<AutomationRun>,
}

#[derive(Deserialize, Serialize)]
struct AutomationRun {
    id: String,
    timestamp: String,
    outcome: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationResource {
    Routines,
    Bindings,
}

impl AutomationResource {
    fn path_segment(&self) -> &'static str {
        match self {
            Self::Routines => "routines",
            Self::Bindings => "bindings",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    Start,
    Stop,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceAction {
    Computer {
        action: ComputerAction,
    },
    Resume {
        resource: AutomationResource,
        id: String,
    },
    History {
        resource: AutomationResource,
        id: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedWork {
    instruction: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    managed: bool,
    #[serde(flatten)]
    interruption: WorkInterruption,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkInterruption {
    key: String,
    recorded_at: Option<u64>,
    reason_message: String,
    output: Option<String>,
    outcome_unknown: bool,
    recovery: Option<WorkRecovery>,
}

#[derive(Deserialize, Serialize)]
pub struct WorkRecovery {
    action: RecoveryAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryAction {
    Cancel,
    Retry,
}

#[derive(Deserialize, Serialize)]
pub struct Conversation {
    id: String,
    title: String,
    preview: Option<String>,
}

#[derive(Deserialize)]
struct ConversationHistory {
    conversations: Vec<Conversation>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Exchange {
    Closed {
        #[serde(rename = "status")]
        _status: ClosedStatus,
        #[serde(flatten)]
        details: ClosedWorkspace,
    },
    Paused {
        #[serde(rename = "status")]
        _status: PauseStatus,
        #[serde(flatten)]
        details: PausedWorkspace,
    },
    Session {
        token: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum PauseStatus {
    Paused,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedWorkspace {
    operation_id: String,
    reason: Option<String>,
    support_email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ClosedStatus {
    Closed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedWorkspace {
    operation_id: String,
    execution_cutoff: ClosureCutoff,
    online_cleanup: String,
    remote_revocation: String,
    backups: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ClosureCutoff {
    sessions: String,
    work: String,
    computer: String,
}

pub struct Cloud {
    origin: Option<Url>,
    sign_in: Mutex<SignIn>,
}

impl Cloud {
    pub fn configured() -> Self {
        let origin = std::env::var("OPENBOT_PERSONAL_SAAS_URL")
            .ok()
            .or_else(|| option_env!("OPENBOT_PERSONAL_SAAS_URL").map(str::to_owned))
            .as_deref()
            .and_then(parse_origin);
        Self {
            origin,
            sign_in: Mutex::default(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.origin.is_some()
    }

    fn action(
        &self,
        action: Action,
        open: impl Fn(Url) -> Result<(), &'static str>,
    ) -> Result<View, &'static str> {
        let Some(origin) = &self.origin else {
            return Ok(View::Unavailable);
        };
        let mut sign_in = self.sign_in.lock().map_err(|_| NETWORK_ERROR)?;
        if matches!(&*sign_in, SignIn::Waiting(attempt) if attempt.expired()) {
            *sign_in = SignIn::Failed(SignInFailure::Incomplete);
        }
        if matches!(action, Action::Cancel) && matches!(*sign_in, SignIn::Waiting(_)) {
            *sign_in = SignIn::Idle;
            return Ok(View::SignedOut);
        }
        if matches!(*sign_in, SignIn::Waiting(_)) {
            return Ok(View::Waiting);
        }
        if let (Action::Status, SignIn::Failed(failure)) = (action, &*sign_in) {
            return Ok(View::SignInFailed {
                message: failure.message(),
            });
        }

        let action = match action {
            Action::Closure => {
                open(endpoint(origin, "/auth/closure/start"))?;
                Action::Status
            }
            Action::Export => {
                open(endpoint(origin, "/workspace"))?;
                Action::Status
            }
            _ => action,
        };
        if let (Action::Status, SignIn::Closed(details)) = (action, &*sign_in) {
            return Ok(View::Closed(details.clone()));
        }
        if let (Action::Status, SignIn::Paused(details)) = (action, &*sign_in) {
            return Ok(View::Paused(details.clone()));
        }

        let store = credential(origin)?;
        let token = match store.get_password() {
            Ok(token) => Some(token),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err(STORE_ERROR),
        };
        if let Some(token) = token {
            *sign_in = SignIn::Idle;
            return Api::new(origin)?.session_action(action, &store, &token);
        }
        if matches!(action, Action::Start) {
            let (attempt, start) = Attempt::new(origin)?;
            open(start)?;
            *sign_in = SignIn::Waiting(attempt);
            return Ok(View::Waiting);
        }
        Ok(View::SignedOut)
    }

    fn complete(&self, link: &Url) -> bool {
        let (Some(origin), Ok(mut sign_in)) = (&self.origin, self.sign_in.lock()) else {
            return false;
        };
        let SignIn::Waiting(attempt) = &*sign_in else {
            return false;
        };
        let Some(result) = attempt.result(link) else {
            return false;
        };
        *sign_in = match result {
            Return::Failed(failure) => SignIn::Failed(failure),
            Return::Code(code) => match exchange_and_store(origin, attempt, &code) {
                Ok(state) => state,
                Err(failure) => SignIn::Failed(failure),
            },
        };
        true
    }
}

fn credential(origin: &Url) -> Result<keyring::Entry, &'static str> {
    keyring::Entry::new(STORE_SERVICE, origin.as_str()).map_err(|_| STORE_ERROR)
}

fn clear_credential(store: &keyring::Entry) -> Result<(), &'static str> {
    match store.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(STORE_ERROR),
    }
}

fn exchange_and_store(
    origin: &Url,
    attempt: &Attempt,
    code: &str,
) -> Result<SignIn, SignInFailure> {
    let api = Api::new(origin).map_err(|_| SignInFailure::Incomplete)?;
    let store = credential(origin).map_err(|_| SignInFailure::StoreUnavailable)?;
    let token = match api
        .exchange(attempt, code)
        .map_err(|_| SignInFailure::Incomplete)?
    {
        Exchange::Closed { details, .. } => {
            clear_credential(&store).map_err(|_| SignInFailure::StoreUnavailable)?;
            return Ok(SignIn::Closed(details));
        }
        Exchange::Paused { details, .. } => {
            clear_credential(&store).map_err(|_| SignInFailure::StoreUnavailable)?;
            return Ok(SignIn::Paused(details));
        }
        Exchange::Session { token } if !token.is_empty() => token,
        Exchange::Session { .. } => return Err(SignInFailure::Incomplete),
    };
    if store.set_password(&token).is_err() {
        let _ = api.end_session(&token);
        return Err(SignInFailure::StoreUnavailable);
    }
    Ok(SignIn::Idle)
}

fn endpoint(origin: &Url, path: &str) -> Url {
    let mut url = origin.clone();
    url.set_path(path);
    url
}

struct Api<'a> {
    origin: &'a Url,
    http: Client,
}

impl<'a> Api<'a> {
    fn new(origin: &'a Url) -> Result<Self, &'static str> {
        let http = Client::builder()
            .redirect(Policy::custom(|attempt| {
                attempt.error("unexpected cloud API redirect")
            }))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| NETWORK_ERROR)?;
        Ok(Self { origin, http })
    }

    fn exchange(&self, attempt: &Attempt, code: &str) -> Result<Exchange, &'static str> {
        let result = self
            .http
            .post(endpoint(self.origin, "/api/auth/native/exchange"))
            .json(&serde_json::json!({
                "client": CLIENT,
                "state": attempt.state,
                "code": code,
                "code_verifier": attempt.verifier,
            }))
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        if result.status() != StatusCode::OK {
            return Err(NETWORK_ERROR);
        }
        result.json().map_err(|_| NETWORK_ERROR)
    }

    fn end_session(&self, token: &str) -> Result<StatusCode, &'static str> {
        self.http
            .post(endpoint(self.origin, "/auth/sign-out"))
            .bearer_auth(token)
            .send()
            .map(|result| result.status())
            .map_err(|_| NETWORK_ERROR)
    }

    fn session_action(
        &self,
        action: Action,
        store: &keyring::Entry,
        token: &str,
    ) -> Result<View, &'static str> {
        if matches!(action, Action::SignOut) {
            return match self.end_session(token)? {
                StatusCode::NO_CONTENT | StatusCode::UNAUTHORIZED => {
                    clear_credential(store)?;
                    Ok(View::SignedOut)
                }
                _ => Err(NETWORK_ERROR),
            };
        }
        if matches!(action, Action::Prepare) {
            let result = self
                .http
                .post(endpoint(self.origin, "/workspace/prepare"))
                .bearer_auth(token)
                .send()
                .map_err(|_| NETWORK_ERROR)?;
            match result.status() {
                StatusCode::NO_CONTENT => {}
                StatusCode::UNAUTHORIZED => {
                    clear_credential(store)?;
                    return Ok(View::SignedOut);
                }
                StatusCode::SERVICE_UNAVAILABLE => return admissions_status(result),
                _ => return Err(NETWORK_ERROR),
            }
        }
        let result = self
            .http
            .get(endpoint(self.origin, "/api/workspace"))
            .bearer_auth(token)
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        match result.status() {
            StatusCode::OK => {
                let workspace_access = access_ms(&result)?;
                let Workspace {
                    id,
                    personal_assistant,
                    quotas,
                    test_credits,
                    recovery,
                    recovery_can_retry,
                    workspace_recovery,
                } = result.json().map_err(|_| NETWORK_ERROR)?;
                let history = self
                    .http
                    .get(endpoint(self.origin, "/api/workspace/conversations"))
                    .bearer_auth(token)
                    .send()
                    .map_err(|_| NETWORK_ERROR)?;
                match history.status() {
                    StatusCode::OK => {
                        let access_ms = workspace_access.min(access_ms(&history)?);
                        let ConversationHistory { conversations } =
                            history.json().map_err(|_| NETWORK_ERROR)?;
                        Ok(View::Workspace(Box::new(WorkspaceView {
                            id,
                            personal_assistant,
                            conversations,
                            access_ms,
                            quotas,
                            test_credits,
                            recovery,
                            recovery_can_retry,
                            workspace_recovery,
                        })))
                    }
                    StatusCode::UNAUTHORIZED => {
                        clear_credential(store)?;
                        Ok(View::SignedOut)
                    }
                    _ => Err(NETWORK_ERROR),
                }
            }
            StatusCode::ACCEPTED => Ok(View::Preparing),
            StatusCode::SERVICE_UNAVAILABLE => admissions_status(result),
            StatusCode::UNAUTHORIZED => {
                clear_credential(store)?;
                Ok(View::SignedOut)
            }
            _ => Err(NETWORK_ERROR),
        }
    }
}

fn admissions_status(result: reqwest::blocking::Response) -> Result<View, &'static str> {
    #[derive(Deserialize)]
    struct WorkspaceError {
        error: String,
    }
    let response: WorkspaceError = result.json().map_err(|_| NETWORK_ERROR)?;
    match response.error.as_str() {
        "workspace_admissions_paused" => Ok(View::AdmissionsPaused),
        _ => Err(NETWORK_ERROR),
    }
}

fn access_ms(response: &reqwest::blocking::Response) -> Result<u64, &'static str> {
    response
        .headers()
        .get("openbot-access-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .filter(|value| (1..=60_000).contains(value))
        .ok_or(NETWORK_ERROR)
}

pub fn show<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => {
            let mut destination = super::setup_destination(app)?;
            destination.set_fragment(Some(WINDOW));
            let allowed = destination.clone();
            tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::External(destination))
                .title("OpenBot Cloud")
                .inner_size(720.0, 560.0)
                .min_inner_size(520.0, 420.0)
                .on_navigation(move |url| url == &allowed)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()
                .map_err(|error| error.to_string())?
        }
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn receive<R: Runtime>(app: &tauri::AppHandle<R>, link: Url) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if app.state::<Cloud>().complete(&link) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if handle.get_webview_window(WINDOW).is_some() {
                    let _ = show(&handle);
                }
            });
        }
    });
}

fn require_cloud_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), &'static str> {
    if window.label() != WINDOW
        || !window.url().ok().is_some_and(|url| {
            super::setup_destination(window.app_handle()).is_ok_and(|mut setup| {
                setup.set_fragment(Some(WINDOW));
                setup == url
            })
        })
    {
        return Err("Cloud commands are only available in the OpenBot Cloud window.");
    }
    Ok(())
}

#[tauri::command]
pub async fn personal_cloud_action<R: Runtime>(
    window: WebviewWindow<R>,
    action: Action,
) -> Result<View, String> {
    require_cloud_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Cloud>().action(action, |url| {
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|_| "Could not open your system browser. Try again.")
        })
    })
    .await
    .map_err(|_| NETWORK_ERROR)?
    .map_err(str::to_owned)
}

#[derive(Serialize)]
struct RecoveryRequest<'a> {
    action: RecoveryAction,
    acknowledged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    quote: Option<&'a TestCreditQuoteRef>,
}

#[tauri::command]
pub async fn personal_cloud_recover<R: Runtime>(
    window: WebviewWindow<R>,
    key: String,
    action: RecoveryAction,
    acknowledged: bool,
    quote: Option<TestCreditQuoteRef>,
) -> Result<WorkRecovery, String> {
    require_cloud_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cloud = app.state::<Cloud>();
        let origin = cloud.origin.as_ref().ok_or(NETWORK_ERROR)?;
        let token = credential(origin)?
            .get_password()
            .map_err(|_| STORE_ERROR)?;
        let api = Api::new(origin)?;
        let mut url = endpoint(origin, "/api/workspace/recovery");
        url.path_segments_mut()
            .map_err(|_| NETWORK_ERROR)?
            .push(&key);
        let reply = api
            .http
            .post(url)
            .bearer_auth(token)
            .json(&RecoveryRequest {
                action,
                acknowledged,
                quote: quote.as_ref(),
            })
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        if quote.is_some() && reply.status() == StatusCode::CONFLICT {
            return Err(
                "Refresh your workspace and review the current Test Credit price before retrying.",
            );
        }
        if reply.status() == StatusCode::PAYMENT_REQUIRED {
            return Err("Not enough Test Credits to reserve this Bot run.");
        }
        if reply.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err("Your workspace has reached its Bot run limit.");
        }
        if !reply.status().is_success() {
            return Err(NETWORK_ERROR);
        }
        reply.json().map_err(|_| NETWORK_ERROR)
    })
    .await
    .map_err(|_| NETWORK_ERROR)?
    .map_err(str::to_owned)
}

#[tauri::command]
pub async fn personal_cloud_workspace<R: Runtime>(
    window: WebviewWindow<R>,
    action: WorkspaceAction,
) -> Result<Option<AutomationHistory>, String> {
    require_cloud_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cloud = app.state::<Cloud>();
        let origin = cloud.origin.as_ref().ok_or(NETWORK_ERROR)?;
        let token = credential(origin)?
            .get_password()
            .map_err(|_| STORE_ERROR)?;
        let api = Api::new(origin)?;
        let mut url = endpoint(origin, "/api/workspace");
        {
            let mut parts = url.path_segments_mut().map_err(|_| NETWORK_ERROR)?;
            match &action {
                WorkspaceAction::Computer { action } => parts.extend([
                    "computer",
                    match action {
                        ComputerAction::Start => "start",
                        ComputerAction::Stop => "stop",
                    },
                ]),
                WorkspaceAction::Resume { resource, id } => {
                    parts.extend(["automation", resource.path_segment(), id, "resume"])
                }
                WorkspaceAction::History { resource, id } => {
                    parts.extend(["automation", resource.path_segment(), id, "runs"])
                }
            };
        }
        let read = matches!(action, WorkspaceAction::History { .. });
        let request = if read {
            url.query_pairs_mut().append_pair("format", "summary");
            api.http.get(url)
        } else {
            api.http.post(url)
        };
        let reply = request
            .bearer_auth(token)
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        if reply.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err("Your workspace has reached its resource limit.");
        }
        if !reply.status().is_success() {
            return Err(NETWORK_ERROR);
        }
        if read {
            return reply.json().map(Some).map_err(|_| NETWORK_ERROR);
        }
        Ok(None)
    })
    .await
    .map_err(|_| NETWORK_ERROR)?
    .map_err(str::to_owned)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCreditQuoteRef {
    route: String,
    price_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRunInput {
    workspace_id: String,
    bot_id: String,
    instruction: String,
    request_id: String,
    quote: TestCreditQuoteRef,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRunAccepted {
    run_id: String,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum BotRunSubmission {
    Accepted(BotRunAccepted),
    QuoteChanged { error: &'static str },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BotRunState {
    Queued,
    Running,
    Waiting,
    Stopped,
    Completed,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BotRunReceiptState {
    Reserved,
    Pending,
    Settled,
    Released,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotRunReceipt {
    model: String,
    state: BotRunReceiptState,
    held_microcredits: String,
    charged_microcredits: Option<String>,
    released_microcredits: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRunStatus {
    state: BotRunState,
    output: Option<String>,
    test_credit: Option<BotRunReceipt>,
}

#[tauri::command]
pub async fn personal_cloud_start_bot_run<R: Runtime>(
    window: WebviewWindow<R>,
    input: BotRunInput,
) -> Result<BotRunSubmission, String> {
    require_cloud_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cloud = app.state::<Cloud>();
        let origin = cloud.origin.as_ref().ok_or(NETWORK_ERROR)?;
        let token = credential(origin)?
            .get_password()
            .map_err(|_| STORE_ERROR)?;
        let reply = Api::new(origin)?
            .http
            .post(endpoint(origin, "/api/workspace/bot-runs"))
            .bearer_auth(token)
            .header("Idempotency-Key", input.request_id.as_str())
            .json(&serde_json::json!({
                "workspaceId": input.workspace_id,
                "botId": input.bot_id,
                "instruction": input.instruction,
                "execution": "test-credit",
                "quote": input.quote,
            }))
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        match reply.status() {
            StatusCode::ACCEPTED => reply
                .json()
                .map(BotRunSubmission::Accepted)
                .map_err(|_| NETWORK_ERROR),
            StatusCode::CONFLICT => {
                let error = reply
                    .json::<serde_json::Value>()
                    .map_err(|_| NETWORK_ERROR)?;
                if error.get("error").and_then(serde_json::Value::as_str)
                    == Some("test_credit_quote_changed")
                {
                    Ok(BotRunSubmission::QuoteChanged {
                        error: "test_credit_quote_changed",
                    })
                } else {
                    Err(NETWORK_ERROR)
                }
            }
            StatusCode::PAYMENT_REQUIRED => Err("There are not enough Test Credits for this run."),
            StatusCode::TOO_MANY_REQUESTS => Err("Your workspace has reached its Bot run limit."),
            _ => Err(NETWORK_ERROR),
        }
    })
    .await
    .map_err(|_| NETWORK_ERROR)?
    .map_err(str::to_owned)
}

#[tauri::command]
pub async fn personal_cloud_bot_run<R: Runtime>(
    window: WebviewWindow<R>,
    run_id: String,
    stop: bool,
) -> Result<Option<BotRunStatus>, String> {
    require_cloud_window(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cloud = app.state::<Cloud>();
        let origin = cloud.origin.as_ref().ok_or(NETWORK_ERROR)?;
        let token = credential(origin)?
            .get_password()
            .map_err(|_| STORE_ERROR)?;
        let api = Api::new(origin)?;
        let mut url = endpoint(origin, "/api/workspace/bot-runs");
        {
            let mut segments = url.path_segments_mut().map_err(|_| NETWORK_ERROR)?;
            segments.push(&run_id);
            if stop {
                segments.push("stop");
            }
        }
        let request = if stop {
            api.http.post(url)
        } else {
            api.http.get(url)
        };
        let reply = request
            .bearer_auth(token)
            .send()
            .map_err(|_| NETWORK_ERROR)?;
        match (stop, reply.status()) {
            (true, StatusCode::ACCEPTED) => Ok(None),
            (false, StatusCode::OK) => reply.json().map(Some).map_err(|_| NETWORK_ERROR),
            _ => Err(NETWORK_ERROR),
        }
    })
    .await
    .map_err(|_| NETWORK_ERROR)?
    .map_err(str::to_owned)
}

#[tauri::command]
pub fn personal_cloud_show_local<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    require_cloud_window(&window)?;
    let local = window
        .app_handle()
        .get_webview_window("main")
        .ok_or("Could not find local OpenBot.")?;
    local.unminimize().map_err(|error| error.to_string())?;
    local.show().map_err(|error| error.to_string())?;
    local.set_focus().map_err(|error| error.to_string())?;
    window.destroy().map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "personal_cloud_tests.rs"]
mod tests;
