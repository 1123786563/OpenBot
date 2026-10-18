//! Employee identity from the customer's OpenBot authority. Intelligence credentials are separate.
use crate::problem::{Connection, Problem};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

// MT098: pub(crate) so org_context reads the saved session and reuses the verified dial.
pub(crate) const SAVED_COOKIE: &str = "OPENBOT_ORGANIZATION_SESSION";
const CALLBACK: &str = "/organization-auth/callback";
const PATIENCE: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OrganizationUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub role: String,
}

// MT098: pub(crate) so org_context reuses the exact verified session shape.
// MT099: PartialEq/Eq/Debug so tests can pin which authority holds which session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SavedSession {
    pub(crate) authority: String,
    pub(crate) cookie: String,
}

struct Pending {
    root: PathBuf,
    authority: String,
    state: String,
    verifier: String,
    receiver: Option<mpsc::Receiver<Result<String, Problem>>>,
    cancelled: Arc<AtomicBool>,
}
static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<Option<Pending>> {
    PENDING.get_or_init(|| Mutex::new(None))
}
fn problem(message: &str) -> Problem {
    Problem::plain(message)
}
fn auth_problem(message: &str) -> Problem {
    problem(message).connection(Connection::Organization)
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

// MT098: pub so the bin crate's sign-in gate compares the same normalized origin the session
// saved (the rest of the MT098 surface stays pub(crate) inside this crate).
pub fn authority(value: &str) -> Result<String, Problem> {
    let url = Url::parse(value.trim())
        .map_err(|_| problem("Enter your organization's OpenBot sign-in URL."))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(problem("Use the HTTPS origin of your organization's OpenBot. HTTP is allowed only for a local test."));
    }
    Ok(url.origin().ascii_serialization())
}

// MT098: pub(crate) so org_context dials with the same client discipline.
pub(crate) fn client() -> Result<Client, Problem> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| problem("OpenBot could not prepare organization sign-in."))
}

// MT098: pub(crate) so org_context verifies through the same tested path.
pub(crate) fn verify(client: &Client, saved: &SavedSession) -> Result<OrganizationUser, Problem> {
    #[derive(Deserialize)]
    struct Me {
        user: OrganizationUser,
    }
    let response = client
        .get(format!("{}/api/me", saved.authority))
        .header("cookie", &saved.cookie)
        .send()
        .map_err(|_| {
            problem("OpenBot could not reach your organization. Try again when it is available.")
        })?;
    if response.status() == 401 || response.status() == 403 {
        return Err(auth_problem("Sign in to your organization again."));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not answer. Try again when it is available.",
        ));
    }
    let user = response
        .json::<Me>()
        .map_err(|_| problem("Your organization returned an invalid sign-in response."))?
        .user;
    if user.id.is_empty()
        || user.id == "dev-local-user"
        || user.email.is_empty()
        || !matches!(user.role.as_str(), "admin" | "user")
    {
        return Err(auth_problem(
            "Your organization has not granted this account access to OpenBot.",
        ));
    }
    Ok(user)
}

fn saved(root: &Path, expected: &str) -> Result<Option<SavedSession>, Problem> {
    recall_session(root, expected)
}

/// The session of one organization, recovered from that organization's own credential
/// namespace (MT099). Recovery is bound to the initiating authority: a session belongs to
/// the authority that signed in, and no other authority ever sees it. An MT098-era flat
/// entry migrates into the namespace the first time its own authority recovers it; a flat
/// entry naming another authority is neither adopted nor destroyed.
pub(crate) fn recall_session(root: &Path, expected: &str) -> Result<Option<SavedSession>, Problem> {
    if let Some(encoded) = crate::credential_namespace::org_recall(
        root,
        expected,
        crate::credential_namespace::SESSION_CREDENTIAL,
    )? {
        let session: SavedSession = serde_json::from_str(&encoded)
            .map_err(|_| auth_problem("Sign in to your organization again."))?;
        return Ok(Some(session));
    }
    let Some(value) = crate::vault::recall(root, SAVED_COOKIE)? else {
        return Ok(None);
    };
    let session: SavedSession = serde_json::from_str(&value)
        .map_err(|_| auth_problem("Sign in to your organization again."))?;
    if session.authority != expected {
        return Ok(None);
    }
    crate::credential_namespace::org_remember(
        root,
        expected,
        crate::credential_namespace::SESSION_CREDENTIAL,
        &value,
    )?;
    // An MT098-era installation had exactly one session — the current one. The migration
    // restores that fact, but never overrides a current mark another sign-in already set.
    if crate::credential_namespace::current_organization(root)?.is_none() {
        crate::credential_namespace::set_current_organization(root, expected)?;
    }
    crate::vault::forget(root, SAVED_COOKIE)?;
    Ok(Some(session))
}

/// Store a finished sign-in's session inside the initiating authority's own namespace
/// (MT099). The authority comes from the pending sign-in itself, never from a caller, so a
/// switch during the callback cannot move another organization's ownership.
pub(crate) fn store_session(
    root: &Path,
    authority: &str,
    session: &SavedSession,
) -> Result<(), Problem> {
    let encoded = serde_json::to_string(session)
        .map_err(|_| problem("OpenBot could not save organization sign-in."))?;
    crate::credential_namespace::org_remember(
        root,
        authority,
        crate::credential_namespace::SESSION_CREDENTIAL,
        &encoded,
    )?;
    // The installation now acts as this organization (a finished sign-in is the switch).
    crate::credential_namespace::set_current_organization(root, authority)
}

pub fn status(root: &Path, authority_url: &str) -> Result<Option<OrganizationUser>, Problem> {
    let expected = authority(authority_url)?;
    saved(root, &expected)?
        .map(|session| verify(&client()?, &session))
        .transpose()
}

pub fn cancel(root: &Path) {
    if let Ok(mut held) = pending().lock() {
        if held.as_ref().is_some_and(|run| run.root == root) {
            if let Some(run) = held.take() {
                run.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn callback_code(request: &str, expected_state: &str) -> Result<String, Problem> {
    let first = request.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(problem("The organization sign-in callback was invalid."));
    }
    let target = parts.next().unwrap_or("");
    let parsed = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| problem("The organization sign-in callback was invalid."))?;
    let parameters: Vec<_> = parsed.query_pairs().collect();
    let states: Vec<_> = parameters
        .iter()
        .filter(|(key, _)| key == "state")
        .collect();
    let codes: Vec<_> = parameters.iter().filter(|(key, _)| key == "code").collect();
    if parsed.path() != CALLBACK
        || states.len() != 1
        || states[0].1 != expected_state
        || codes.len() != 1
        || codes[0].1.len() != 32
        || !codes[0].1.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(problem(
            "The organization sign-in callback did not match this request. Sign in again.",
        ));
    }
    Ok(codes[0].1.to_string())
}

fn receive_callback(stream: &mut TcpStream, expected_state: &str) -> Result<String, Problem> {
    let result = crate::provider_oauth::read_callback_request(stream, Duration::from_secs(3))
        .map_err(|_| problem("OpenBot could not read the organization callback."))
        .and_then(|request| callback_code(&request, expected_state));
    let (status, message) = if result.is_ok() {
        ("200 OK", "Sign-in received. You can return to OpenBot.")
    } else {
        (
            "400 Bad Request",
            "Sign-in did not match. Return to OpenBot and try again.",
        )
    };
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}", message.len());
    let _ = stream.write_all(reply.as_bytes());
    result
}

pub fn begin(root: &Path, authority_url: &str, provider: &str) -> Result<String, Problem> {
    let authority = authority(authority_url)?;
    if !matches!(provider, "google" | "microsoft" | "okta") {
        return Err(problem("Choose Google, Microsoft, or Okta."));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| problem("OpenBot could not receive the organization sign-in callback."))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| problem("OpenBot could not prepare the organization callback."))?;
    let port = listener
        .local_addr()
        .map_err(|_| problem("OpenBot could not read its callback address."))?
        .port();
    let state = random();
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (sender, receiver) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_listener = cancelled.clone();
    let expected_state = state.clone();
    let mut url = Url::parse(&format!("{authority}/api/auth/desktop"))
        .map_err(|_| problem("The organization URL is invalid."))?;
    url.query_pairs_mut()
        .append_pair("provider", provider)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair(
            "redirect_uri",
            &format!("http://127.0.0.1:{port}{CALLBACK}"),
        );
    let mut held = pending()
        .lock()
        .map_err(|_| problem("Restart OpenBot to begin organization sign-in."))?;
    if let Some(old) = held.take() {
        old.cancelled.store(true, Ordering::SeqCst);
    }
    *held = Some(Pending {
        root: root.to_path_buf(),
        authority,
        state,
        verifier,
        receiver: Some(receiver),
        cancelled,
    });
    std::thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < PATIENCE && !cancel_listener.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let result = receive_callback(&mut stream, &expected_state);
                    let _ = sender.send(result);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Err(_) => {
                    let _ = sender.send(Err(problem(
                        "OpenBot could not receive the organization callback.",
                    )));
                    return;
                }
            }
        }
        let _ = sender.send(Err(problem(
            "Organization sign-in expired or was cancelled. Try again.",
        )));
    });
    Ok(url.to_string())
}

pub fn finish(root: &Path) -> Result<OrganizationUser, Problem> {
    let (run_authority, run_state, run_verifier, receiver, cancelled) = {
        let mut held = pending()
            .lock()
            .map_err(|_| problem("Restart OpenBot to finish organization sign-in."))?;
        let run = held
            .as_mut()
            .filter(|run| run.root == root)
            .ok_or_else(|| problem("Begin organization sign-in for this installation first."))?;
        (
            run.authority.clone(),
            run.state.clone(),
            run.verifier.clone(),
            run.receiver
                .take()
                .ok_or_else(|| problem("This sign-in is already waiting for the browser."))?,
            run.cancelled.clone(),
        )
    };
    let code = receiver
        .recv_timeout(PATIENCE)
        .map_err(|_| problem("Organization sign-in expired. Try again."))??;
    if cancelled.load(Ordering::SeqCst) {
        return Err(problem("Organization sign-in was cancelled."));
    }
    let client = client()?;
    let response = client.post(format!("{}/api/auth/electron/token", run_authority)).header("origin", &run_authority)
        .json(&serde_json::json!({ "token": code, "state": run_state, "code_verifier": run_verifier })).send()
        .map_err(|_| problem("OpenBot could not finish organization sign-in. Try again."))?;
    if response.status().is_client_error() {
        return Err(auth_problem(
            "Your organization refused this sign-in. Try again.",
        ));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not complete sign-in. Try again.",
        ));
    }
    let cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .find(|value| {
            value.starts_with("better-auth.session_token=")
                || value.starts_with("__Secure-better-auth.session_token=")
        })
        .ok_or_else(|| problem("Your organization did not return an OpenBot session."))?
        .to_string();
    let session = SavedSession {
        authority: run_authority.clone(),
        cookie,
    };
    let user = verify(&client, &session)?;
    let mut held = pending()
        .lock()
        .map_err(|_| problem("Restart OpenBot to finish organization sign-in."))?;
    if cancelled.load(Ordering::SeqCst)
        || !held
            .as_ref()
            .is_some_and(|run| run.state == run_state && run.root == root)
    {
        return Err(problem("Organization sign-in was cancelled or replaced."));
    }
    // The completed session lands in the initiating authority's own namespace (MT099): the
    // authority is the pending run's own, so a sign-in begun for another organization can
    // never reassign this one's ownership.
    store_session(root, &run_authority, &session)?;
    held.take();
    Ok(user)
}

/// A one-use navigation sets the local HttpOnly cookie; credentials never enter renderer IPC.
pub fn session_destination(
    root: &Path,
    authority_url: &str,
    app_url: &str,
) -> Result<String, Problem> {
    let authority = authority(authority_url)?;
    let session = saved(root, &authority)?
        .ok_or_else(|| auth_problem("Sign in to your organization to open OpenBot."))?;
    let client = client()?;
    verify(&client, &session)?;
    let mut destination = Url::parse(app_url)
        .map_err(|_| problem("OpenBot could not find this installation's application."))?;
    if destination.scheme() != "http"
        || !matches!(
            destination.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
    {
        return Err(problem(
            "The installed OpenBot application must be on this computer.",
        ));
    }
    destination.set_path("/api/auth/organization/session");
    destination.set_query(None);
    destination.set_fragment(None);
    #[derive(Deserialize)]
    struct Ticket {
        ticket: String,
    }
    let response = client
        .post(destination.clone())
        .header("origin", destination.origin().ascii_serialization())
        .json(&serde_json::json!({ "cookie": session.cookie }))
        .send()
        .map_err(|_| {
            problem("OpenBot could not deliver your organization sign-in to this installation.")
        })?;
    if response.status() == 401 || response.status() == 403 {
        return Err(auth_problem("Sign in to your organization again."));
    }
    if !response.status().is_success() {
        return Err(problem(
            "Your organization could not answer. Try again when it is available.",
        ));
    }
    let ticket = response
        .json::<Ticket>()
        .map_err(|_| problem("OpenBot did not accept your organization session."))?;
    if ticket.ticket.is_empty() || ticket.ticket.len() > 128 {
        return Err(problem("OpenBot returned an invalid sign-in handoff."));
    }
    destination
        .query_pairs_mut()
        .append_pair("ticket", &ticket.ticket);
    Ok(destination.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    fn callback_over_tcp(nonblocking: bool, fragmented: bool) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        browser
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "browser connection was not accepted"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("browser connection failed: {error}"),
            }
        };
        // Unix does not consistently inherit this flag; model the Windows accept behavior.
        if nonblocking {
            stream.set_nonblocking(true).unwrap();
        } else {
            stream.set_nonblocking(false).unwrap();
        }
        let request = b"GET /organization-auth/callback?state=expected&code=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let split = if fragmented { 18 } else { 0 };
        if fragmented {
            browser.write_all(&request[..split]).unwrap();
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender
                .send(receive_callback(&mut stream, "expected"))
                .unwrap();
        });
        let early = receiver.recv_timeout(Duration::from_millis(100));
        if !matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
            worker.join().unwrap();
            panic!("callback completed before its request line arrived: {early:?}");
        }
        browser.write_all(&request[split..]).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            "a".repeat(32)
        );
        let mut response = String::new();
        browser.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        worker.join().unwrap();
    }

    #[test]
    fn callback_waits_for_delayed_get_on_nonblocking_stream() {
        callback_over_tcp(true, false);
    }

    #[test]
    fn callback_waits_for_fragmented_request_line() {
        callback_over_tcp(false, true);
    }

    #[test]
    fn cancellation_retires_a_finish_already_waiting_for_the_browser() {
        let root = PathBuf::from("organization-cancellation-fixture");
        begin(&root, "https://company.example", "google").unwrap();
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || finish(&worker_root));
        let deadline = Instant::now() + Duration::from_secs(2);
        while pending()
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|run| run.receiver.is_some())
        {
            assert!(Instant::now() < deadline, "finish did not start waiting");
            std::thread::yield_now();
        }
        cancel(&root);
        assert!(worker.join().unwrap().is_err());
        assert!(pending().lock().unwrap().is_none());
    }
    #[test]
    fn only_rejected_sessions_request_organization_refresh() {
        for (status, expected) in [
            ("401 Unauthorized", Some(Connection::Organization)),
            ("503 Service Unavailable", None),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                assert_eq!(line, "GET /api/me HTTP/1.1\r\n");
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let result = verify(
                &client().unwrap(),
                &SavedSession {
                    authority: format!("http://{address}"),
                    cookie: "better-auth.session_token=fixture".into(),
                },
            );
            assert_eq!(result.unwrap_err().connection, expected);
            worker.join().unwrap();
        }
    }
    #[test]
    fn authority_is_explicit_and_cannot_smuggle_credentials_or_destinations() {
        assert_eq!(
            authority("https://company.example").unwrap(),
            "https://company.example"
        );
        for bad in [
            "http://company.example",
            "https://person:password@company.example",
            "https://company.example/path",
            "https://company.example?next=elsewhere",
        ] {
            assert!(authority(bad).is_err());
        }
    }
    #[test]
    fn callback_requires_the_exact_single_state_and_code() {
        let code = "a".repeat(32);
        assert_eq!(
            callback_code(
                &format!("GET {CALLBACK}?code={code}&state=expected HTTP/1.1\r\n"),
                "expected"
            )
            .unwrap(),
            code
        );
        for query in [
            format!("code={code}&state=wrong"),
            format!("code={code}&state=expected&state=expected"),
            "code=short&state=expected".into(),
        ] {
            assert!(
                callback_code(&format!("GET {CALLBACK}?{query} HTTP/1.1\r\n"), "expected").is_err()
            );
        }
    }

    // --- MT099: the session lives in its organization's credential namespace (AC1/AC3) ---

    fn saved_session(authority: &str) -> SavedSession {
        SavedSession {
            authority: authority.to_string(),
            cookie: format!("better-auth.session_token=fixture-for-{authority}"),
        }
    }

    fn encoded_session(session: &SavedSession) -> String {
        serde_json::to_string(session).unwrap()
    }

    #[test]
    fn credential_namespace_the_session_lives_in_its_own_organizations_namespace() {
        let root = crate::test_support::temp_root("org-session-namespace");
        store_session(&root, "https://company-a.example", &saved_session("https://company-a.example")).unwrap();
        // The owning authority recovers its own session…
        let recalled = recall_session(&root, "https://company-a.example")
            .unwrap()
            .expect("the session belongs to this authority");
        assert_eq!(recalled.authority, "https://company-a.example");
        // …another authority sees nothing (recovery is bound to the initiating authority),
        // and nothing was ever written to the legacy flat slot.
        assert_eq!(
            recall_session(&root, "https://company-b.example").unwrap(),
            None
        );
        assert_eq!(crate::vault::recall(&root, SAVED_COOKIE).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn credential_namespace_a_legacy_flat_session_migrates_into_its_authoritys_namespace() {
        let root = crate::test_support::temp_root("org-session-legacy-migrate");
        let authority = "https://company-a.example";
        crate::vault::remember(&root, SAVED_COOKIE, &encoded_session(&saved_session(authority)))
            .unwrap();
        // The first recovery reads the MT098-era flat entry and moves it into the namespace.
        let recalled = recall_session(&root, authority).unwrap().expect("legacy session recovered");
        assert_eq!(recalled.authority, authority);
        assert_eq!(crate::vault::recall(&root, SAVED_COOKIE).unwrap(), None, "the flat copy is retired once the namespace holds the session");
        assert_eq!(
            crate::credential_namespace::org_recall(
                &root,
                authority,
                crate::credential_namespace::SESSION_CREDENTIAL
            )
            .unwrap()
            .is_some(),
            true
        );
        // The next recovery reads the namespace copy.
        assert_eq!(
            recall_session(&root, authority).unwrap().unwrap().authority,
            authority
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn credential_namespace_a_legacy_session_of_another_authority_is_never_adopted() {
        let root = crate::test_support::temp_root("org-session-legacy-foreign");
        let stored_authority = "https://company-a.example";
        let legacy = encoded_session(&saved_session(stored_authority));
        crate::vault::remember(&root, SAVED_COOKIE, &legacy).unwrap();
        // Recovery for another authority adopts nothing.
        assert_eq!(
            recall_session(&root, "https://company-b.example").unwrap(),
            None
        );
        // The legacy record is neither adopted nor destroyed: it still belongs to A.
        assert_eq!(
            crate::vault::recall(&root, SAVED_COOKIE).unwrap().as_deref(),
            Some(legacy.as_str())
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn credential_namespace_completing_one_organizations_sign_in_never_touches_another() {
        let root = crate::test_support::temp_root("org-session-ownership");
        let authority_a = "https://company-a.example";
        let authority_b = "https://company-b.example";
        store_session(&root, authority_a, &saved_session(authority_a)).unwrap();
        // While A's session is stored, B completes its own sign-in (the callback path pins
        // B's pending to B's authority; the storage face of that pinning is this write).
        store_session(&root, authority_b, &saved_session(authority_b)).unwrap();
        // Both organizations keep exactly their own session: the callback completion never
        // overwrites another organization's ownership (spec A7).
        assert_eq!(
            recall_session(&root, authority_a).unwrap().unwrap().cookie,
            saved_session(authority_a).cookie
        );
        assert_eq!(
            recall_session(&root, authority_b).unwrap().unwrap().cookie,
            saved_session(authority_b).cookie
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn credential_namespace_a_stored_session_makes_its_authority_the_installations_current() {
        let root = crate::test_support::temp_root("org-session-current");
        store_session(&root, "https://company-a.example", &saved_session("https://company-a.example")).unwrap();
        assert_eq!(
            crate::credential_namespace::current_organization(&root).unwrap().as_deref(),
            Some("https://company-a.example")
        );
        // A later completion moves the current mark; the earlier session stays in its own
        // namespace for its own organization (cleanup, not overwrite, retires it).
        store_session(&root, "https://company-b.example", &saved_session("https://company-b.example")).unwrap();
        assert_eq!(
            crate::credential_namespace::current_organization(&root).unwrap().as_deref(),
            Some("https://company-b.example")
        );
        assert_eq!(
            recall_session(&root, "https://company-a.example").unwrap().unwrap().authority,
            "https://company-a.example"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
