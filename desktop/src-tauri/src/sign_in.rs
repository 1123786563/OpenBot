//! The sentences and decisions the desktop sign-in flows share, in one place.
//!
//! Six flows begin and finish a sign-in (`claude`, `chatgpt`, `self_hosted_intelligence`,
//! `intelligence`, `organization`, `model_oauth` in main.rs). Their protocols differ — plan
//! containers, a browser session, an authority's PKCE handshake, a provider's device code —
//! but what a person is told when the shared machinery fails is one small set of sentences,
//! and the organization gate is one decision. Those live here so the flows cannot drift
//! apart (MOD20 / #640): the sentences are a user-visible contract, byte-fixed by the tests
//! below, and the PKCE pair both OAuth flows assemble is minted once.

use crate::problem::Problem;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The verifier, state, and challenge pair the Google model flow (provider_oauth) and the
/// organization flow (organization_auth) both sign their authorization request with. Each
/// call mints a fresh pair, so a second start invalidates the first (MT098).
pub(crate) fn pkce_pair() -> (String, String, String) {
    let verifier = crate::provider_oauth::random();
    let state = crate::provider_oauth::random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, state, challenge)
}

/// A finish found no sign-in waiting: an earlier finish or a restart already took it.
/// Shared verbatim by the three slot-based flows (Claude, ChatGPT, Intelligence).
pub const NO_LONGER_RUNNING: &str = "That sign-in is no longer running. Start it again.";

/// The blocking task that was finishing a sign-in never came back from the thread pool.
pub fn did_not_finish(error: impl std::fmt::Display) -> Problem {
    Problem::plain(format!("The sign-in did not finish: {error}"))
}

/// The blocking task that was to start a plan sign-in never ran (Claude, ChatGPT flows).
pub fn task_did_not_run(error: impl std::fmt::Display) -> Problem {
    Problem::with(
        "The sign-in did not start. Try again.",
        format!("the sign-in task did not run: {error}"),
    )
}

/// A self-hosted Intelligence sign-in was superseded by a cancel or a newer attempt.
pub fn self_hosted_cancelled() -> Problem {
    Problem::plain("That Intelligence sign-in was cancelled.")
}

/// The self-hosted flow's blocking task never came back, at either half.
pub fn self_hosted_task_failed() -> Problem {
    Problem::plain("Intelligence sign-in could not finish.")
}

/// Cancelling the self-hosted flow's blocking task never came back.
pub fn self_hosted_close_failed() -> Problem {
    Problem::plain("The Intelligence sign-in could not be closed.")
}

/// The organization flow's blocking task never came back from beginning a sign-in.
pub fn organization_start_failed() -> Problem {
    Problem::plain("Organization sign-in could not start.")
}

/// The organization flow's blocking task never came back from finishing a sign-in.
pub fn organization_did_not_finish() -> Problem {
    Problem::plain("Organization sign-in did not finish.")
}

/// The run a sign-in began in is no longer the run finishing it: the stack was stopped and
/// started again, or another installation's root became current (MT098).
pub fn previous_run() -> Problem {
    Problem::plain("That sign-in belongs to a previous OpenBot run. Open this installation again.")
}

/// May this installation sign in to `authority_url`? A verified connection is not to be
/// walked into another organization's sign-in by a client selector (MT098, spec A7). A
/// context fresh on disk pins this installation to its authority; nothing established,
/// corrupt, or stale is the ordinary recovery path.
pub fn admit_organization_sign_in(
    root: &Path,
    authority_url: &str,
    now_ms: u64,
) -> Result<(), Problem> {
    let declared = crate::organization_auth::authority(authority_url)?;
    let gate = crate::org_context::Gate::from_persisted(crate::org_context::load_persisted(root)?);
    gate.admit_sign_in(&declared, now_ms).map_err(|refusal| {
        Problem::plain(format!(
            "This installation already belongs to another organization. ({})",
            refusal.code()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sentences are the user-visible contract of every flow through this seam; each is
    /// pinned byte-for-byte so a wording edit has to be a decision, not a drive-by (AC④).
    #[test]
    fn the_shared_sentences_are_byte_exact() {
        assert_eq!(
            NO_LONGER_RUNNING,
            "That sign-in is no longer running. Start it again."
        );
        let unfinished = did_not_finish("thread gone");
        assert_eq!(unfinished.said, "The sign-in did not finish: thread gone");
        assert_eq!(unfinished.detail, None);
        let unstarted = task_did_not_run("join error");
        assert_eq!(unstarted.said, "The sign-in did not start. Try again.");
        assert_eq!(
            unstarted.detail.as_deref(),
            Some("the sign-in task did not run: join error")
        );
        assert_eq!(
            self_hosted_cancelled().said,
            "That Intelligence sign-in was cancelled."
        );
        assert_eq!(
            self_hosted_task_failed().said,
            "Intelligence sign-in could not finish."
        );
        assert_eq!(
            self_hosted_close_failed().said,
            "The Intelligence sign-in could not be closed."
        );
        assert_eq!(
            organization_start_failed().said,
            "Organization sign-in could not start."
        );
        assert_eq!(
            organization_did_not_finish().said,
            "Organization sign-in did not finish."
        );
        assert_eq!(
            previous_run().said,
            "That sign-in belongs to a previous OpenBot run. Open this installation again."
        );
    }

    /// The pair is minted together: two independent URL-safe values, and the challenge bound
    /// to exactly this verifier, so a second start invalidates the first (AC①, provider_oauth
    /// and organization_auth both consume it).
    #[test]
    fn pkce_pair_binds_its_challenge_to_its_verifier() {
        for _ in 0..8 {
            let (verifier, state, challenge) = pkce_pair();
            assert_ne!(verifier, state);
            for value in [&verifier, &state, &challenge] {
                assert_eq!(value.len(), 43, "URL_SAFE_NO_PAD of 32 bytes");
                assert!(value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
            }
            assert_eq!(
                challenge,
                URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
            );
        }
    }

    /// A sign-in is admitted by an unpinned installation and by its own authority, and
    /// refused — with the exact sentence — for another organization's (AC①, MT098).
    #[test]
    fn admitting_a_sign_in_is_bound_to_the_persisted_authority() {
        let root = crate::test_support::temp_root("sign-in-gate");
        std::fs::create_dir_all(&root).unwrap();
        let now = 1_000_000u64;
        // Nothing persisted (or a corrupt record) is the ordinary recovery path: admit.
        assert!(admit_organization_sign_in(&root, "https://company-a.example", now).is_ok());
        crate::vault::remember(&root, crate::org_context::VAULT_KEY, "not a context").unwrap();
        assert!(admit_organization_sign_in(&root, "https://company-a.example", now).is_ok());
        // Freshly verified for company-a: pins the installation to that authority.
        crate::org_context::persist(
            &root,
            &crate::org_context::FrozenContext {
                authority: "https://company-a.example".into(),
                user: crate::org_context::ContextUser {
                    id: "user-1".into(),
                    email: "person@company-a.example".into(),
                    name: None,
                    role: "user".into(),
                },
                company: None,
                team: None,
                established_at_ms: now,
                verified_at_ms: now,
            },
        )
        .unwrap();
        assert!(
            admit_organization_sign_in(&root, "https://company-a.example", now + 1_000).is_ok()
        );
        // Another organization's sign-in is refused, with the refusal code carried through.
        let refusal = admit_organization_sign_in(&root, "https://company-b.example", now + 1_000)
            .unwrap_err();
        assert_eq!(
            refusal.said,
            "This installation already belongs to another organization. (ORG_CONTEXT_AUTHORITY_MISMATCH)"
        );
        assert_eq!(refusal.detail, None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
