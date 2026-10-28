//! Leaving or switching an organization wipes exactly that organization's business state —
//! its media, its caches, its subscriptions, its credentials — and nothing else. (MT100 /
//! Issue #143)
//!
//! MT099 gave every organization its own credential namespace; this module is the other half
//! of that contract: the organization-scoped state that is not a credential (media files,
//! caches, subscription registrations) lives under the same authority-derived key
//! (`.openbot/organizations/<sha256(authority)>/`), so cleanup can name its target exactly.
//! Personal provider credentials are never in an organization's area — they are not this
//! module's target and cannot become one (the area is derived from an authority, and personal
//! state has none).
//!
//! The wipe order is deliberate and idempotent: **data first, credentials last.** An
//! interrupted cleanup leaves an organization that can still authenticate but has already
//! lost some state; a retry re-runs every step, each of which is a no-op on what is already
//! gone, until the receipt says `completed`. Nothing here can leave a half-cleaned
//! organization that a later pass cannot finish.
//!
//! Evidence, not secrets: the receipt and the bounded evidence log carry identifiers
//! (credential names, subscription ids) and counts — never values, never session bytes.

use crate::credential_namespace as creds;
use crate::organization_auth as auth;
use crate::problem::Problem;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The per-organization state area, directly under the installation's `.openbot` directory.
pub const ORG_STATE_DIR: &str = "organizations";
/// One organization's media files (downloads, attachments), under its state area.
pub const MEDIA_SUBDIR: &str = "media";
/// One organization's regenerable caches, under its state area.
pub const CACHE_SUBDIR: &str = "cache";
/// One organization's subscription registrations, as a JSON array of identifiers.
pub const SUBSCRIPTIONS_FILE: &str = "subscriptions.json";
/// The bounded evidence log for cleanup runs (lives OUTSIDE any organization's area).
pub const EVIDENCE_LOG_FILE: &str = "org-cleanup-evidence.log";
/// How many evidence lines survive; the oldest falls off.
pub const EVIDENCE_LOG_CAP: usize = 64;

/// The root `.openbot` directory of an installation.
fn openbot_dir(root: &Path) -> PathBuf {
    root.join(".openbot")
}

/// One organization's state area: `<root>/.openbot/organizations/<sha256(authority)>`.
/// The key is the same derivation the credential namespace uses, so an organization's data
/// and its credentials share exactly one identity.
pub fn org_state_dir(root: &Path, authority: &str) -> Result<PathBuf, Problem> {
    let hash = creds::namespace_hash(authority)?;
    Ok(openbot_dir(root).join(ORG_STATE_DIR).join(hash))
}

/// One organization's media directory (created by writers, lazily).
pub fn org_media_dir(root: &Path, authority: &str) -> Result<PathBuf, Problem> {
    Ok(org_state_dir(root, authority)?.join(MEDIA_SUBDIR))
}

/// One organization's cache directory (created by writers, lazily).
pub fn org_cache_dir(root: &Path, authority: &str) -> Result<PathBuf, Problem> {
    Ok(org_state_dir(root, authority)?.join(CACHE_SUBDIR))
}

fn subscriptions_path(root: &Path, authority: &str) -> Result<PathBuf, Problem> {
    Ok(org_state_dir(root, authority)?.join(SUBSCRIPTIONS_FILE))
}

/// Register one subscription under an organization. Identifiers only — a subscription's
/// tokens are credentials and belong in the organization's credential namespace, never here.
pub fn remember_subscription(
    root: &Path,
    authority: &str,
    subscription_id: &str,
) -> Result<(), Problem> {
    if subscription_id.trim().is_empty() {
        return Err(Problem::plain("Choose a name for this subscription."));
    }
    let path = subscriptions_path(root, authority)?;
    let mut subscriptions = read_subscriptions_at(&path)?;
    if !subscriptions.iter().any(|known| known == subscription_id) {
        subscriptions.push(subscription_id.to_string());
        subscriptions.sort();
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "OpenBot could not create this organization's state directory.",
                error.to_string(),
            )
        })?;
    }
    let encoded = serde_json::to_string(&subscriptions).map_err(|error| {
        Problem::with(
            "OpenBot could not record this organization's subscription.",
            error.to_string(),
        )
    })?;
    std::fs::write(&path, encoded).map_err(|error| {
        Problem::with(
            "OpenBot could not record this organization's subscription.",
            error.to_string(),
        )
    })
}

/// The subscription identifiers registered under one organization (empty when none).
pub fn subscriptions(root: &Path, authority: &str) -> Result<Vec<String>, Problem> {
    read_subscriptions_at(&subscriptions_path(root, authority)?)
}

fn read_subscriptions_at(path: &Path) -> Result<Vec<String>, Problem> {
    let Some(raw) = std::fs::read_to_string(path).ok() else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw).map_err(|error| {
        Problem::with(
            "OpenBot could not read this organization's subscriptions.",
            error.to_string(),
        )
    })
}

/// One step of a cleanup run: what it targeted and whether it finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStep {
    /// Which area this step targeted.
    pub target: CleanupTarget,
    /// Whether the step's writes finished without error (a no-op counts as finished).
    pub finished: bool,
    /// How many entries the step removed (identifiers live in the receipt, not here).
    pub removed: u64,
}

/// The state areas a cleanup can target, in wipe order: data first, credentials last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupTarget {
    Subscriptions,
    Media,
    Cache,
    Credentials,
}

/// The receipt of one cleanup run. Identifiers and counts only — never values, never
/// sessions: this is the observable evidence the person (and a reviewer) reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReceipt {
    /// The normalized authority whose state was wiped.
    pub authority: String,
    /// The credential names removed from the organization's namespace.
    pub credentials: Vec<String>,
    /// The subscription identifiers removed.
    pub subscriptions: Vec<String>,
    /// How many media entries were removed.
    pub media_entries: u64,
    /// How many cache entries were removed.
    pub cache_entries: u64,
    /// Each step's outcome, in wipe order.
    pub steps: Vec<CleanupStep>,
    /// The failing step's own sentence, when a step did not finish (identifiers only —
    /// never the underlying values).
    pub detail: Option<String>,
    /// Whether every area verified empty after the run (a retry reaches true).
    pub completed: bool,
}

/// One evidence-log line: what a run cleaned, when, and whether it finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEvidence {
    pub at_ms: u64,
    pub authority: String,
    pub credentials: usize,
    pub subscriptions: usize,
    pub media_entries: u64,
    pub cache_entries: u64,
    pub completed: bool,
}

fn count_entries(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|entries| entries.count() as u64)
        .unwrap_or(0)
}

/// Wipe exactly `authority`'s organization state and return the receipt. Every step is
/// idempotent; a failure leaves the receipt saying which area is still populated, and a
/// retry of the whole call finishes the job. An argument that is not a usable authority is
/// refused outright — cleanup never guesses its target.
pub fn forget_organization_state(root: &Path, authority: &str) -> Result<CleanupReceipt, Problem> {
    let normalized = auth::authority(authority)?;
    let mut receipt = CleanupReceipt {
        authority: normalized.clone(),
        credentials: Vec::new(),
        subscriptions: Vec::new(),
        media_entries: 0,
        cache_entries: 0,
        steps: Vec::new(),
        detail: None,
        completed: false,
    };
    let mut problem: Option<Problem> = None;

    // 1. Subscriptions: read the identifiers (for the receipt), then delete the file.
    let subscriptions_file = subscriptions_path(root, &normalized)?;
    let known = read_subscriptions_at(&subscriptions_file)?;
    receipt.subscriptions = known;
    match std::fs::remove_file(&subscriptions_file) {
        Ok(()) => receipt.steps.push(CleanupStep {
            target: CleanupTarget::Subscriptions,
            finished: true,
            removed: receipt.subscriptions.len() as u64,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            receipt.steps.push(CleanupStep {
                target: CleanupTarget::Subscriptions,
                finished: true,
                removed: 0,
            });
        }
        Err(error) => {
            problem = Some(Problem::with(
                "OpenBot could not remove this organization's subscriptions.",
                error.to_string(),
            ));
            receipt.steps.push(CleanupStep {
                target: CleanupTarget::Subscriptions,
                finished: false,
                removed: 0,
            });
        }
    }

    // 2 & 3. Media and caches: count then remove the directories outright.
    for (target, subdir) in [
        (CleanupTarget::Media, MEDIA_SUBDIR),
        (CleanupTarget::Cache, CACHE_SUBDIR),
    ] {
        let dir = org_state_dir(root, &normalized)?.join(subdir);
        let removed = count_entries(&dir);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => receipt.steps.push(CleanupStep {
                target,
                finished: true,
                removed,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                receipt.steps.push(CleanupStep {
                    target,
                    finished: true,
                    removed: 0,
                });
            }
            Err(error) => {
                problem = Some(Problem::with(
                    "OpenBot could not remove this organization's files.",
                    error.to_string(),
                ));
                receipt.steps.push(CleanupStep {
                    target,
                    finished: false,
                    removed,
                });
            }
        }
        if target == CleanupTarget::Media {
            receipt.media_entries = removed;
        } else {
            receipt.cache_entries = removed;
        }
    }

    // 4. Credentials last: the organization's namespace (session included) and, when the
    //    current pointer names this organization, that pointer too.
    if problem.is_none() {
        match creds::forget_organization(root, &normalized) {
            Ok(names) => {
                receipt.credentials = names;
                receipt.steps.push(CleanupStep {
                    target: CleanupTarget::Credentials,
                    finished: true,
                    removed: receipt.credentials.len() as u64,
                });
            }
            Err(error) => {
                problem = Some(error);
                receipt.steps.push(CleanupStep {
                    target: CleanupTarget::Credentials,
                    finished: false,
                    removed: 0,
                });
            }
        }
    }

    // Verification: every area must read back empty before this run says completed.
    let verified_empty = subscriptions(root, &normalized)?.is_empty()
        && !org_media_dir(root, &normalized)?.exists()
        && !org_cache_dir(root, &normalized)?.exists()
        && creds::org_credentials(root, &normalized)?.is_empty();
    receipt.completed = verified_empty && problem.is_none();
    receipt.detail = problem.as_ref().map(|problem| problem.said.clone());

    append_evidence(root, &receipt)?;
    // A run that did not verify clean returns its receipt — the observable evidence of what
    // is still populated — rather than an error only the caller's logs would hold.
    Ok(receipt)
}

fn evidence_path(root: &Path) -> PathBuf {
    openbot_dir(root).join(EVIDENCE_LOG_FILE)
}

fn append_evidence(root: &Path, receipt: &CleanupReceipt) -> Result<(), Problem> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default();
    let entry = CleanupEvidence {
        at_ms: now_ms,
        authority: receipt.authority.clone(),
        credentials: receipt.credentials.len(),
        subscriptions: receipt.subscriptions.len(),
        media_entries: receipt.media_entries,
        cache_entries: receipt.cache_entries,
        completed: receipt.completed,
    };
    let line = serde_json::to_string(&entry).map_err(|error| {
        Problem::with(
            "OpenBot could not record its cleanup evidence.",
            error.to_string(),
        )
    })?;
    let path = evidence_path(root);
    let existing: Vec<String> = std::fs::read_to_string(&path)
        .map(|raw| {
            raw.lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut lines = existing;
    lines.push(line);
    let keep_from = lines.len().saturating_sub(EVIDENCE_LOG_CAP);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "OpenBot could not record its cleanup evidence.",
                error.to_string(),
            )
        })?;
    }
    let mut file = std::fs::File::create(&path).map_err(|error| {
        Problem::with(
            "OpenBot could not record its cleanup evidence.",
            error.to_string(),
        )
    })?;
    for kept in &lines[keep_from..] {
        file.write_all(kept.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|error| {
                Problem::with(
                    "OpenBot could not record its cleanup evidence.",
                    error.to_string(),
                )
            })?;
    }
    Ok(())
}

/// The bounded evidence log, oldest first (identifiers and counts only).
pub fn cleanup_evidence(root: &Path) -> Result<Vec<CleanupEvidence>, Problem> {
    let raw = std::fs::read_to_string(evidence_path(root)).unwrap_or_default();
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|error| {
                Problem::with(
                    "OpenBot could not read its cleanup evidence.",
                    error.to_string(),
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_namespace::{org_recall, org_remember, SESSION_CREDENTIAL};
    use crate::test_support::temp_root;
    use crate::vault;

    const COMPANY_A: &str = "https://company-a.example";
    const COMPANY_B: &str = "https://company-b.example";

    fn root(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).expect("create owned fixture root");
        root
    }

    /// Seed one organization's full state: credentials, subscriptions, media, caches.
    fn seed_org(root: &Path, authority: &str, tag: &str) {
        org_remember(
            root,
            authority,
            SESSION_CREDENTIAL,
            &format!("cookie-{tag}"),
        )
        .unwrap();
        org_remember(root, authority, "BILLING", &format!("billing-secret-{tag}")).unwrap();
        remember_subscription(root, authority, &format!("plan-{tag}")).unwrap();
        let media = org_media_dir(root, authority).unwrap();
        std::fs::create_dir_all(media.join("avatars")).unwrap();
        std::fs::write(media.join("avatars").join("me.png"), b"media-bytes").unwrap();
        let cache = org_cache_dir(root, authority).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("index.bin"), b"cache-bytes").unwrap();
    }

    // --- AC1: after a switch/leave, the old organization's state is unusable ----------

    #[test]
    fn mt100_old_organization_state_is_gone_after_cleanup() {
        let root = root("mt100-gone");
        seed_org(&root, COMPANY_A, "a");
        let receipt = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(receipt.completed, "cleanup must verify every area empty");
        assert_eq!(receipt.credentials.len(), 2);
        assert_eq!(receipt.subscriptions, ["plan-a"]);
        assert_eq!(receipt.media_entries, 1, "the avatars directory");
        assert_eq!(receipt.cache_entries, 1);
        // Nothing is readable back: no session, no billing secret, no subscriptions, no dirs.
        assert_eq!(
            org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap(),
            None
        );
        assert_eq!(org_recall(&root, COMPANY_A, "BILLING").unwrap(), None);
        assert!(subscriptions(&root, COMPANY_A).unwrap().is_empty());
        assert!(!org_media_dir(&root, COMPANY_A).unwrap().exists());
        assert!(!org_cache_dir(&root, COMPANY_A).unwrap().exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- AC2: another organization's data and personal credentials survive -----------

    #[test]
    fn mt100_other_organizations_and_personal_credentials_survive() {
        let root = root("mt100-reverse");
        seed_org(&root, COMPANY_A, "a");
        seed_org(&root, COMPANY_B, "b");
        // A personal provider credential, as the closed personal set stores them.
        vault::remember(&root, "OPENAI_API_KEY", "personal-key-value").unwrap();
        let receipt = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(receipt.completed);
        // Company B is untouched, end to end.
        assert_eq!(
            org_recall(&root, COMPANY_B, SESSION_CREDENTIAL)
                .unwrap()
                .as_deref(),
            Some("cookie-b")
        );
        assert_eq!(
            org_recall(&root, COMPANY_B, "BILLING").unwrap().as_deref(),
            Some("billing-secret-b")
        );
        assert_eq!(subscriptions(&root, COMPANY_B).unwrap(), ["plan-b"]);
        assert!(org_media_dir(&root, COMPANY_B).unwrap().exists());
        assert!(org_cache_dir(&root, COMPANY_B).unwrap().exists());
        // The personal credential is not an organization's to clean.
        assert_eq!(
            vault::recall(&root, "OPENAI_API_KEY").unwrap().as_deref(),
            Some("personal-key-value")
        );
        // And A's cleanup did not touch B's credential names.
        assert_eq!(receipt.credentials, ["BILLING", "SESSION"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- AC3: a failed run leaves a retryable state, never a silent half-clean --------

    #[test]
    fn mt100_retry_after_failure_reaches_a_complete_cleanup() {
        let root = root("mt100-retry");
        seed_org(&root, COMPANY_A, "a");
        // A directory where a file must be: media removal fails because a FILE sits where
        // the media directory's child should be removed — simulate by making the media
        // directory's parent read-only instead, which fails remove_dir_all on macOS/Linux.
        let media = org_media_dir(&root, COMPANY_A).unwrap();
        std::fs::create_dir_all(&media).unwrap();
        std::fs::write(media.join("stuck.bin"), b"stuck").unwrap();
        let mut permissions = std::fs::metadata(&media).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o500);
        }
        std::fs::set_permissions(&media, permissions).unwrap();
        let first = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(
            !first.completed,
            "a blocked media directory cannot verify clean"
        );
        assert!(
            first.steps.iter().any(|step| !step.finished),
            "the receipt must name the unfinished step"
        );
        // The credentials step never ran (data first, credentials last), so the session
        // is still whole — the organization was not half-retired.
        assert_eq!(
            org_recall(&root, COMPANY_A, SESSION_CREDENTIAL)
                .unwrap()
                .as_deref(),
            Some("cookie-a")
        );
        // Unblock and retry: the whole call again, reaching a complete cleanup.
        let mut permissions = std::fs::metadata(&media).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o700);
        }
        std::fs::set_permissions(&media, permissions).unwrap();
        let second = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(second.completed, "retry must finish every remaining step");
        assert_eq!(
            org_recall(&root, COMPANY_A, SESSION_CREDENTIAL).unwrap(),
            None
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mt100_retry_on_a_clean_organization_is_a_safe_no_op() {
        let root = root("mt100-idempotent");
        let receipt = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(receipt.completed);
        assert!(receipt.credentials.is_empty());
        assert!(receipt.subscriptions.is_empty());
        assert_eq!(receipt.media_entries, 0);
        assert_eq!(receipt.cache_entries, 0);
        let again = forget_organization_state(&root, COMPANY_A).unwrap();
        assert!(again.completed);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- AC4: evidence without secrets -----------------------------------------------

    #[test]
    fn mt100_evidence_log_carries_counts_and_names_never_values() {
        let root = root("mt100-evidence");
        seed_org(&root, COMPANY_A, "a");
        forget_organization_state(&root, COMPANY_A).unwrap();
        let evidence = cleanup_evidence(&root).unwrap();
        assert_eq!(evidence.len(), 1);
        assert!(evidence[0].completed);
        assert_eq!(evidence[0].credentials, 2);
        assert_eq!(evidence[0].subscriptions, 1);
        let raw = std::fs::read_to_string(evidence_path(&root)).unwrap();
        assert!(
            !raw.contains("cookie-a"),
            "session values never enter evidence"
        );
        assert!(
            !raw.contains("billing-secret-a"),
            "secret values never enter evidence"
        );
        assert!(
            raw.contains(COMPANY_A),
            "the authority identifier is the evidence key"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mt100_evidence_log_is_bounded() {
        let root = root("mt100-bounded");
        for _ in 0..(EVIDENCE_LOG_CAP + 5) {
            forget_organization_state(&root, COMPANY_A).unwrap();
        }
        assert_eq!(cleanup_evidence(&root).unwrap().len(), EVIDENCE_LOG_CAP);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // --- the target itself is validated, never guessed -------------------------------

    #[test]
    fn mt100_an_unusable_authority_is_refused_before_anything_is_touched() {
        let root = root("mt100-refused");
        assert!(forget_organization_state(&root, "not a url").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
