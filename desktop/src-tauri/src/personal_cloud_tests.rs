use super::*;

#[test]
fn browser_start_uses_s256_and_fresh_state_without_selecting_a_redirect() {
    let origin = parse_origin("https://personal.example").unwrap();
    let (first, start) = Attempt::new(&origin).unwrap();
    let (second, _) = Attempt::new(&origin).unwrap();
    assert_ne!(first.state, second.state);
    assert_ne!(first.verifier, second.verifier);
    for value in [&first.state, &first.verifier] {
        assert_eq!(value.len(), 43);
        assert_eq!(URL_SAFE_NO_PAD.decode(value).unwrap().len(), 32);
    }
    assert_eq!(start.path(), "/auth/native/start");
    let params: std::collections::HashMap<_, _> = start.query_pairs().into_owned().collect();
    assert_eq!(params.len(), 3);
    assert_eq!(params["client"], "desktop");
    assert_eq!(params["state"], first.state);
    assert_eq!(
        params["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(first.verifier.as_bytes()))
    );
}

#[test]
fn callback_requires_exact_uri_single_result_and_current_state() {
    let origin = parse_origin("https://personal.example").unwrap();
    let (attempt, _) = Attempt::new(&origin).unwrap();
    for link in [
        "openbot://auth/wrong",
        "openbot://other/auth/personal-saas",
        "openbot://user@auth/personal-saas",
        "openbot://auth:80/personal-saas",
        "https://auth/personal-saas",
    ] {
        assert!(attempt
            .result(
                &format!("{link}?state={}&code=opaque", attempt.state)
                    .parse()
                    .unwrap()
            )
            .is_none());
    }
    for query in [
        "state=wrong&code=opaque".into(),
        format!("state={0}&state={0}&code=opaque", attempt.state),
        format!(
            "state={}&code=opaque&error=account_unavailable",
            attempt.state
        ),
        format!("state={}&code=opaque#extra", attempt.state),
    ] {
        assert!(attempt
            .result(&format!("{RETURN_URI}?{query}").parse().unwrap())
            .is_none());
    }
    let code = format!("{RETURN_URI}?state={}&code=new%2Bcode", attempt.state)
        .parse()
        .unwrap();
    assert!(matches!(attempt.result(&code), Some(Return::Code(code)) if code == "new+code"));
    let failed = format!(
        "{RETURN_URI}?state={}&error=email_unverified",
        attempt.state
    )
    .parse()
    .unwrap();
    assert!(matches!(
        attempt.result(&failed),
        Some(Return::Failed(SignInFailure::EmailUnverified))
    ));
}

#[test]
fn configuration_accepts_only_a_bare_https_origin() {
    assert!(parse_origin("https://personal.example:8443/").is_some());
    for bad in [
        "http://personal.example",
        "https://user@personal.example",
        "https://personal.example/subpath",
        "https://personal.example?",
        "https://personal.example/#",
    ] {
        assert!(parse_origin(bad).is_none(), "accepted {bad}");
    }
}

#[test]
fn signed_in_cloud_view_loads_workspace_and_owner_history_with_the_same_session() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let server = std::thread::spawn(move || {
        for (path, body, access_ms) in [
            (
                "/api/workspace",
                r#"{"id":"workspace-1","personalAssistant":{"id":"bot-1","name":"My Assistant"}}"#,
                42_000,
            ),
            (
                "/api/workspace/conversations",
                r#"{"conversations":[{"id":"conversation-1","title":"Weekend <plans>","preview":"Saturday at nine"},{"id":"conversation-2","title":"Groceries","preview":null}]}"#,
                1_000,
            ),
        ] {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert_eq!(request, format!("GET {path} HTTP/1.1\r\n"));
            let headers: Vec<_> = (&mut reader)
                .lines()
                .map(Result::unwrap)
                .take_while(|line| !line.is_empty())
                .collect();
            assert!(headers
                .iter()
                .filter_map(|line| line.split_once(':'))
                .any(|(name, value)| name.eq_ignore_ascii_case("authorization")
                    && value.trim() == "Bearer test-session"));
            write!(
                reader.get_mut(),
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nOpenBot-Access-Ms: {access_ms}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).unwrap();
        }
    });

    let store = keyring::Entry::new("openbot-desktop-test", "unused").unwrap();
    let view = Api::new(&origin)
        .unwrap()
        .session_action(Action::Status, &store, "test-session")
        .unwrap();
    let value = serde_json::to_value(view).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "kind": "workspace",
            "accessMs": 1000,
            "id": "workspace-1",
            "personalAssistant": {"id": "bot-1", "name": "My Assistant"},
            "conversations": [
                {"id": "conversation-1", "title": "Weekend <plans>", "preview": "Saturday at nine"},
                {"id": "conversation-2", "title": "Groceries", "preview": null},
            ]
        })
    );
    server.join().unwrap();
}

#[test]
fn paused_exchange_projects_only_public_status_to_the_cloud_view() {
    let response = serde_json::json!({
        "status": "paused",
        "operationId": "89b4db61-9c69-435f-815b-3ee6de75a313",
        "reason": "Trial paused for review.",
        "supportEmail": "support@example.com",
    });
    let Exchange::Paused { details, .. } = serde_json::from_value(response).unwrap() else {
        panic!("expected a status-only response");
    };
    assert_eq!(
        serde_json::to_value(View::Paused(details)).unwrap(),
        serde_json::json!({
            "kind": "paused",
            "operationId": "89b4db61-9c69-435f-815b-3ee6de75a313",
            "reason": "Trial paused for review.",
            "supportEmail": "support@example.com",
        })
    );
}
