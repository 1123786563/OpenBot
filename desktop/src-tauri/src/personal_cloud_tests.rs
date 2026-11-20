use super::*;

#[test]
fn browser_start_uses_s256_and_fresh_state_without_selecting_a_redirect() {
    let origin = parse_origin("https://personal.example").unwrap();
    let (first, start) = Attempt::new(&origin);
    let (second, _) = Attempt::new(&origin);
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
    let (attempt, _) = Attempt::new(&origin);
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
