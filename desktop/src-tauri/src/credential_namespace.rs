//! Organization credentials live in their own namespace, never in the personal one. (MT099 /
//! Issue #142)
//!
//! RED-1: the tests below were written first, against the API this module exposes; the
//! suite failed until the implementation existed.
//!
//! The desktop keeps two kinds of credentials in one protected store, and MT098 added a third
//! kind without separating them:
//!
//! - **Personal provider credentials** — the person's own model keys and plan tokens
//!   (`OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …). They belong to the installation's
//!   personal space and are read by name from the closed list the Start/Ask flows declare.
//! - **Service credentials** — tokens minted here for these services to prove themselves to
//!   each other. Personal in the same flat sense.
//! - **Organization credentials** (MT099) — secrets that belong to one organization
//!   connection: the session cookie `organization_auth` saved, and later whatever business
//!   credentials a company issues to this desktop. They must never be readable as, or
//!   mistaken for, a personal provider credential, and they must survive — and be cleanable
//!   independently of — every other organization's entries.
//!
//! So an organization credential is stored under a vault name derived from its authority:
//! `OPENBOT_ORGANIZATION.<sha256(authority)>.<CREDENTIAL>`. The derivation is deterministic,
//! filename-safe, and collision-free across authorities. A personal reader addresses the
//! personal closed set and can never construct an organization name; an organization reader
//! must name its authority exactly, and the personal provider names are refused outright —
//! the organization namespace simply has no personal slots (spec A13: personal keys are never
//! company business credentials; A7: attribution follows the authority that initiated it).

use crate::organization_auth as auth;
use crate::problem::Problem;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::Path;

/// The credential name the organization session cookie is stored under inside its
/// organization's namespace (`organization_auth` consumes this).
pub const SESSION_CREDENTIAL: &str = "SESSION";

/// The flat vault key that records which organization this installation currently acts as.
/// It holds the normalized authority string only — an identifier, never a secret. The
/// session cookie itself lives inside the organization's namespace; this pointer says whose
/// namespace the installation is reading.
pub const CURRENT_ORGANIZATION_KEY: &str = "OPENBOT_ORGANIZATION_AUTHORITY";

/// The vault-name prefix every organization credential is stored under. The personal closed
/// set contains nothing with this prefix, and no personal name may enter an organization
/// namespace — the two namespaces share a store, never a name space.
pub const ORGANIZATION_PREFIX: &str = "OPENBOT_ORGANIZATION.";

/// Is this name one of the personal provider credential slots? The closed set is the vault's
/// own secret-name list plus the compatible-endpoint credential slot saved beside them.
pub fn is_personal_credential(name: &str) -> bool {
    crate::vault::is_secret(name)
        || name == crate::saved_intent::COMPATIBLE_CREDENTIAL
}

/// The deterministic vault name for one organization credential. The authority is normalized
/// exactly the way the sign-in saved its session (`organization_auth::authority`), so the
/// namespace key is the same origin string the connection belongs to.
pub fn organization_vault_name(authority: &str, credential: &str) -> Result<String, Problem> {
    if !credential_valid(credential) {
        return Err(namespace_problem(
            "Choose a plain credential name for this organization credential.",
        ));
    }
    if is_personal_credential(credential) {
        // The organization namespace has no personal provider slot: a company credential is
        // never stored as (or mistaken for) somebody's own provider connection, and the
        // personal space is never overwritten from the organization side.
        return Err(namespace_problem(
            "Organization credentials keep their own names; personal provider credentials are never reused for an organization.",
        ));
    }
    Ok(format!(
        "{ORGANIZATION_PREFIX}{}.{credential}",
        namespace_hash(authority)?
    ))
}

/// A credential name is a plain safe word: it becomes one segment of a filename on every
/// platform, so anything beyond letters, digits and underscores is refused, never escaped.
fn credential_valid(credential: &str) -> bool {
    !credential.is_empty()
        && credential.len() <= 64
        && credential
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Store one credential inside `authority`'s organization namespace.
pub fn org_remember(
    root: &Path,
    authority: &str,
    credential: &str,
    value: &str,
) -> Result<(), Problem> {
    let name = organization_vault_name(authority, credential)?;
    crate::vault::remember(root, &name, value)
}

/// Read one credential from `authority`'s organization namespace. Another organization's
/// entry with the same local name is invisible here, and so is every personal credential.
pub fn org_recall(
    root: &Path,
    authority: &str,
    credential: &str,
) -> Result<Option<String>, Problem> {
    let name = organization_vault_name(authority, credential)?;
    crate::vault::recall(root, &name)
}

/// Remove one credential from `authority`'s organization namespace.
pub fn org_forget(root: &Path, authority: &str, credential: &str) -> Result<(), Problem> {
    let name = organization_vault_name(authority, credential)?;
    crate::vault::forget(root, &name)
}

/// The entry suffix the vault gives a stored name on this platform.
#[cfg(target_os = "windows")]
const ENTRY_SUFFIX: &str = ".dpapi";
#[cfg(not(target_os = "windows"))]
const ENTRY_SUFFIX: &str = ".secret";

/// The credential names stored in `authority`'s namespace, in byte order.
pub fn org_credentials(root: &Path, authority: &str) -> Result<Vec<String>, Problem> {
    let hash = namespace_hash(authority)?;
    let prefix = format!("{ORGANIZATION_PREFIX}{hash}.");
    let mut names = Vec::new();
    let entries = std::fs::read_dir(crate::vault::vault_dir(root)?).map_err(|error| {
        Problem::with(
            "OpenBot could not read its credential store on this computer.",
            error.to_string(),
        )
    })?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(stem) = name.strip_suffix(ENTRY_SUFFIX) else {
            continue;
        };
        if let Some(credential) = stem.strip_prefix(&prefix) {
            names.push(credential.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// The url-safe SHA-256 of the normalized authority: the namespace's organization key.
/// `pub(crate)` since MT100: the switch-cleanup module derives its per-organization state
/// directories from the same key, so an organization's data and credentials can never be
/// namespaced apart.
pub(crate) fn namespace_hash(authority: &str) -> Result<String, Problem> {
    let normalized = auth::authority(authority)?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(normalized.as_bytes())))
}

/// Wipe exactly `authority`'s organization namespace and return the credential names it held.
/// Every other organization's entries and every personal credential survive untouched
/// (spec A10 / the switch-cleanup ticket's contract: cleanup never reaches past its target).
pub fn forget_organization(root: &Path, authority: &str) -> Result<Vec<String>, Problem> {
    let names = org_credentials(root, authority)?;
    for credential in &names {
        org_forget(root, authority, credential)?;
    }
    // The wiped organization's own "current" mark retires with it; another organization's
    // pointer (the installation switched elsewhere) is not ours to move.
    if current_organization(root)?.as_deref() == Some(auth::authority(authority)?.as_str()) {
        crate::vault::forget(root, CURRENT_ORGANIZATION_KEY)?;
    }
    Ok(names)
}

fn namespace_problem(message: &'static str) -> Problem {
    Problem::plain(message)
}

/// Record which organization this installation currently acts as. The stored value is the
/// normalized authority — never a secret, never a session.
pub fn set_current_organization(root: &Path, authority: &str) -> Result<(), Problem> {
    let normalized = auth::authority(authority)?;
    crate::vault::remember(root, CURRENT_ORGANIZATION_KEY, &normalized)
}

/// The organization this installation currently acts as, if one is recorded.
pub fn current_organization(root: &Path) -> Result<Option<String>, Problem> {
    crate::vault::recall(root, CURRENT_ORGANIZATION_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    const COMPANY_A: &str = "https://company-a.example";
    const COMPANY_B: &str = "https://company-b.example";

    fn root(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).expect("create owned fixture root");
        root
    }

    // --- AC1: two namespaces, mutually unreadable -------------------------------------

    #[test]
    fn ns1_an_organization_credential_round_trips_inside_its_own_namespace() {
        let root = root("credns-roundtrip");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        assert_eq!(
            org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap().as_deref(),
            Some("cookie-a")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns2_two_organizations_never_see_each_others_entry_with_the_same_local_name() {
        let root = root("credns-cross-authority");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        org_remember(&root, COMPANY_B, SESSION_CREDENTIAL, "cookie-b").unwrap();
        assert_eq!(
            org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap().as_deref(),
            Some("cookie-a")
        );
        assert_eq!(
            org_recall(&root, COMPANY_B, SESSION_CREDENTIAL).unwrap().as_deref(),
            Some("cookie-b")
        );
        // A third authority sees nothing at all.
        assert_eq!(
            org_recall(&root, "https://company-c.example", SESSION_CREDENTIAL).unwrap(),
            None
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns3_a_personal_reader_never_resolves_an_organization_entry() {
        let root = root("credns-personal-blind");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        // The organization entry lives under its derived name, never under any personal name.
        assert_eq!(crate::vault::recall(&root, SESSION_CREDENTIAL).unwrap(), None);
        assert_eq!(
            crate::vault::recall(&root, "OPENAI_API_KEY").unwrap(),
            None,
            "no organization write may land in a personal slot"
        );
        // And the derived name is the only address the entry answers to.
        let derived = organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap();
        assert_eq!(
            crate::vault::recall(&root, &derived).unwrap().as_deref(),
            Some("cookie-a")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns4_the_derived_name_is_deterministic_normalizing_and_authority_bound() {
        // The same origin spelled differently derives the same name: the namespace key is the
        // normalized authority the session itself saved.
        assert_eq!(
            organization_vault_name("https://company-a.example/", SESSION_CREDENTIAL).unwrap(),
            organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap()
        );
        // A different authority derives a different name — the hash isolates organizations.
        assert_ne!(
            organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap(),
            organization_vault_name(COMPANY_B, SESSION_CREDENTIAL).unwrap()
        );
        // The name is deterministic and carries the reserved prefix.
        let name = organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap();
        assert_eq!(
            name,
            organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap()
        );
        assert!(name.starts_with(ORGANIZATION_PREFIX));
        assert!(name.ends_with(SESSION_CREDENTIAL));
    }

    #[test]
    fn ns5_the_namespaces_share_a_store_never_a_name_space() {
        // No derived organization name is ever a personal credential name…
        let name = organization_vault_name(COMPANY_A, SESSION_CREDENTIAL).unwrap();
        assert!(!is_personal_credential(&name));
        // …and no personal credential name carries the organization prefix.
        for personal in [
            "INTELLIGENCE_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            crate::saved_intent::COMPATIBLE_CREDENTIAL,
        ] {
            assert!(is_personal_credential(personal));
            assert!(!personal.starts_with(ORGANIZATION_PREFIX));
        }
    }

    // --- AC2: a personal connection is never a company business credential -------------

    #[test]
    fn ns6_the_organization_namespace_has_no_personal_provider_slot() {
        let root = root("credns-no-personal-slots");
        for personal in [
            "INTELLIGENCE_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            crate::saved_intent::COMPATIBLE_CREDENTIAL,
        ] {
            let error = org_remember(&root, COMPANY_A, personal, "impersonal").unwrap_err();
            assert!(
                !error.said.to_lowercase().contains("impersonal"),
                "the refusal never echoes the value"
            );
            // Nothing was written under the personal name or any derived name.
            assert_eq!(crate::vault::recall(&root, personal).unwrap(), None);
            assert_eq!(org_credentials(&root, COMPANY_A).unwrap(), Vec::<String>::new());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns7_the_organization_side_cannot_read_a_personal_slot_either() {
        let root = root("credns-org-cannot-read-personal");
        crate::vault::remember(&root, "OPENAI_API_KEY", "personal-key").unwrap();
        let error = org_recall(&root, COMPANY_A, "OPENAI_API_KEY").unwrap_err();
        assert!(
            !error.said.contains("personal-key"),
            "the refusal never echoes the secret"
        );
        assert_eq!(
            crate::vault::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("personal-key"),
            "the personal credential is untouched"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns8_organization_writes_leave_personal_credentials_byte_identical() {
        let root = root("credns-personal-survive");
        crate::vault::remember(&root, "OPENAI_API_KEY", "personal-key").unwrap();
        crate::vault::remember(&root, "ANTHROPIC_API_KEY", "personal-key-2").unwrap();
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        org_remember(&root, COMPANY_A, "COMPANY_PROXY_TOKEN", "org-token").unwrap();
        assert_eq!(
            crate::vault::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("personal-key")
        );
        assert_eq!(
            crate::vault::recall(&root, "ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("personal-key-2")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- AC4: cleanup only reaches the target organization ------------------------------

    #[test]
    fn ns9_forget_organization_wipes_only_that_authoritys_namespace() {
        let root = root("credns-scoped-wipe");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        org_remember(&root, COMPANY_A, "COMPANY_PROXY_TOKEN", "org-token").unwrap();
        org_remember(&root, COMPANY_B, SESSION_CREDENTIAL, "cookie-b").unwrap();
        crate::vault::remember(&root, "OPENAI_API_KEY", "personal-key").unwrap();

        let mut removed = forget_organization(&root, COMPANY_A).unwrap();
        removed.sort_unstable();
        assert_eq!(removed, vec!["COMPANY_PROXY_TOKEN", "SESSION"]);

        assert_eq!(org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap(), None);
        assert_eq!(org_recall(&root, COMPANY_A, "COMPANY_PROXY_TOKEN").unwrap(), None);
        // The other organization and the personal space are untouched.
        assert_eq!(
            org_recall(&root, COMPANY_B, SESSION_CREDENTIAL).unwrap().as_deref(),
            Some("cookie-b")
        );
        assert_eq!(
            crate::vault::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("personal-key")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns10_forget_organization_is_idempotent_and_lists_its_namespace() {
        let root = root("credns-idempotent-wipe");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        assert_eq!(
            org_credentials(&root, COMPANY_A).unwrap(),
            vec![SESSION_CREDENTIAL.to_string()]
        );
        assert_eq!(
            forget_organization(&root, COMPANY_A).unwrap(),
            vec![SESSION_CREDENTIAL.to_string()]
        );
        // A second wipe finds nothing and still succeeds.
        assert_eq!(forget_organization(&root, COMPANY_A).unwrap(), Vec::<String>::new());
        assert_eq!(org_credentials(&root, COMPANY_A).unwrap(), Vec::<String>::new());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns11_cleanup_never_touches_the_installations_other_records() {
        let root = root("credns-cleanup-scope");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        // The frozen context record (identifiers only) and MT098-era flat records survive a
        // namespace cleanup: cleanup reaches its own organization's credential entries only.
        crate::vault::remember(&root, crate::org_context::VAULT_KEY, "context-record").unwrap();
        crate::vault::remember(&root, auth::SAVED_COOKIE, "legacy-session").unwrap();

        forget_organization(&root, COMPANY_A).unwrap();
        assert_eq!(
            crate::vault::recall(&root, crate::org_context::VAULT_KEY).unwrap().as_deref(),
            Some("context-record")
        );
        assert_eq!(
            crate::vault::recall(&root, auth::SAVED_COOKIE).unwrap().as_deref(),
            Some("legacy-session")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- Validation: the namespace boundary refuses to guess -----------------------------

    #[test]
    fn ns12_a_credential_name_must_be_a_plain_safe_word() {
        assert!(organization_vault_name(COMPANY_A, "SESSION").is_ok());
        assert!(organization_vault_name(COMPANY_A, "COMPANY_PROXY_TOKEN").is_ok());
        for bad in ["", "has-dash", "has.dot", "has space", "has/slash", &"x".repeat(65)] {
            assert!(
                organization_vault_name(COMPANY_A, bad).is_err(),
                "credential name {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn ns13_the_authority_must_be_a_real_normalized_origin() {
        // The namespace key is the organization authority, held to the same bar the sign-in
        // itself enforces: no plaintext HTTP beyond loopback, no smuggled credentials, paths,
        // queries or fragments.
        for bad in [
            "http://company-a.example",
            "https://person:password@company-a.example",
            "https://company-a.example/path",
            "https://company-a.example?next=elsewhere",
            "not a url",
        ] {
            assert!(
                organization_vault_name(bad, SESSION_CREDENTIAL).is_err(),
                "authority {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn ns14_org_forget_removes_one_entry_and_keeps_the_rest() {
        let root = root("credns-single-forget");
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        org_remember(&root, COMPANY_A, "COMPANY_PROXY_TOKEN", "org-token").unwrap();
        org_forget(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap();
        assert_eq!(org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap(), None);
        assert_eq!(
            org_recall(&root, COMPANY_A, "COMPANY_PROXY_TOKEN").unwrap().as_deref(),
            Some("org-token")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- The installation's current-organization pointer (an identifier, never a secret) ---

    #[test]
    fn ns15_the_current_organization_pointer_round_trips_normalized() {
        let root = root("credns-current-org");
        assert_eq!(current_organization(&root).unwrap(), None);
        set_current_organization(&root, "https://company-a.example/").unwrap();
        assert_eq!(
            current_organization(&root).unwrap().as_deref(),
            Some(COMPANY_A)
        );
        // The pointer is an identifier, not a session: it never carries cookie material.
        assert_eq!(
            crate::vault::recall(&root, CURRENT_ORGANIZATION_KEY).unwrap().as_deref(),
            Some(COMPANY_A)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ns16_cleanup_retires_a_matching_pointer_and_never_another_organizations() {
        let root = root("credns-pointer-scope");
        set_current_organization(&root, COMPANY_A).unwrap();
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        forget_organization(&root, COMPANY_A).unwrap();
        assert_eq!(current_organization(&root).unwrap(), None);

        set_current_organization(&root, COMPANY_B).unwrap();
        org_remember(&root, COMPANY_A, SESSION_CREDENTIAL, "cookie-a").unwrap();
        forget_organization(&root, COMPANY_A).unwrap();
        assert_eq!(
            current_organization(&root).unwrap().as_deref(),
            Some(COMPANY_B),
            "another organization's current mark is not ours to move"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
