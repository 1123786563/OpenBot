//! The frozen organization context of this installation, and the gate that keeps native commands
//! inside the verified organization connection. (MT098 / Issue #141)
//!
//! RED-1: the tests below are written first, against the API this module must expose. The
//! implementation does not exist yet; the suite must fail to compile until it does.

//! The frozen organization context of this installation, and the gate that keeps native commands
//! inside the verified organization connection. (MT098 / Issue #141)
//!
//! One organization connection — the session `organization_auth` verified against the customer's
//! OpenBot authority — freezes exactly one context: the authority it belongs to, the person it was
//! verified as, and the company and team that were chosen against that authority's own listing.
//! Once issued, the identity fields of that context never change; re-verification only moves the
//! time it was last proven. Native commands carry the context they intend to act under, and the
//! gate refuses any command whose context does not match this installation's verified connection —
//! a forged authority, a company or team that was never frozen, or a connection whose session has
//! since died. Nothing here falls back to a default organization: without an established, verified
//! context, gated commands are refused outright (spec §5.2).
//!
//! What the renderer is told (`ContextStatus`) carries names and identifiers only. The session
//! cookie never enters this module's outputs: the DTO has no field for it, and the rejection
//! sentences name codes, never values.

use crate::organization_auth as auth;
use crate::problem::{Connection, Problem};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// The vault key the frozen context persists under. The record holds identifiers only; the
/// session cookie stays in its own `organization_auth` entry and is never copied here.
pub const VAULT_KEY: &str = "OPENBOT_ORGANIZATION_CONTEXT";

/// How long a verification of the connection is trusted before the next gated command must
/// re-prove it against the authority. A restart always re-verifies regardless of this window.
pub const REVERIFY_AFTER_MS: u64 = 15 * 60 * 1000;

/// The rejection log is a bounded ring: the oldest record falls off so a long session cannot
/// grow it without limit.
pub const REJECTION_LOG_CAP: usize = 64;

/// The person the organization authority verified, in this module's own shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub role: String,
}

impl From<auth::OrganizationUser> for ContextUser {
    fn from(user: auth::OrganizationUser) -> Self {
        Self {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
        }
    }
}

/// The frozen company scope: exactly what the authority's own listing said about this company.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyScope {
    pub tenant_id: String,
    pub name: String,
    pub role: String,
    pub member_epoch: i64,
}

/// The frozen team scope; it exists only under its company.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamScope {
    pub workspace_id: String,
    pub name: String,
}

/// The frozen context. `authority` and `user` are the verified identity: they are set once,
/// at establishment, and every later verification must find them byte-identical or the
/// context dies. `company` and `team` are the chosen scopes, copied out of the authority's
/// own listing — never out of anything a caller said.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenContext {
    pub authority: String,
    pub user: ContextUser,
    pub company: Option<CompanyScope>,
    pub team: Option<TeamScope>,
    pub established_at_ms: u64,
    pub verified_at_ms: u64,
}

/// What a person picked, before it is anything at all. The tenant is mandatory here because
/// a team outside a company is not a thing; the command layer refuses the half-shaped choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub tenant_id: String,
    pub workspace_id: Option<String>,
}

/// Why a verification against the authority failed. A dead session is an identity fact and
/// kills the context; an unreachable authority is an infrastructure fact and does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyFailure {
    Expired,
    Unavailable,
}

/// One company and its teams, as the authority's own workspace-scope listing answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTeam {
    pub workspace_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCompany {
    pub tenant_id: String,
    pub name: String,
    pub role: String,
    pub member_epoch: i64,
    pub teams: Vec<CatalogTeam>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyCatalog {
    pub companies: Vec<CatalogCompany>,
}

/// The verified connection a context is frozen against. The production implementation dials
/// the saved session's own authority; tests script this trait so a gate decision can prove
/// it never touched the network.
pub trait OrgConnection {
    /// The authority this connection belongs to. A context is frozen to this exact string.
    fn authority(&self) -> &str;
    /// Who the authority says this session is, right now.
    fn verify(&self) -> Result<ContextUser, VerifyFailure>;
    /// The companies and teams the authority says this person may act under.
    fn scope(&self) -> Result<CompanyCatalog, VerifyFailure>;
}

/// Why establishing a frozen context was refused. The sentence carries the code and nothing
/// else: which tenant or team was offered is the caller's business, never the error's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EstablishRefusal {
    Expired,
    Unavailable,
    ListingUnavailable,
    SelectionUnknown,
    SelectionInvalid,
}

impl EstablishRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Expired => "ORG_CONTEXT_EXPIRED",
            Self::Unavailable => "ORG_CONTEXT_UNAVAILABLE",
            Self::ListingUnavailable => "ORG_CONTEXT_LISTING_UNAVAILABLE",
            Self::SelectionUnknown => "ORG_CONTEXT_SELECTION_UNKNOWN",
            Self::SelectionInvalid => "ORG_CONTEXT_SELECTION_INVALID",
        }
    }
}

/// How much scope a native command needs. Organization is the floor: every gated command
/// runs inside a verified connection. Company and Team demand the frozen scopes exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Requirement {
    Organization,
    Company,
    Team,
}

/// The context a command claims to act under. Unknown fields are refused outright: a payload
/// naming something the frozen model never said cannot be a faithful claim.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandContext {
    pub authority: String,
    #[serde(default)]
    pub tenant_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// What a passed check hands the command: the frozen facts, and none of the claimed ones.
/// There is no secret in here — the session cookie never leaves `organization_auth`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub authority: String,
    pub user_id: String,
    pub company: Option<CompanyScope>,
    pub team: Option<TeamScope>,
}

/// A refusal. The code is the whole message: values are never echoed back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    code: &'static str,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        self.code
    }
}

/// One recorded refusal: a code and the machine time it happened. No claimed value, no
/// tenant or team identifier, ever.
#[derive(Clone, Debug, Serialize)]
pub struct RejectionRecord {
    pub code: &'static str,
    pub at_ms: u64,
}

/// What the vault yielded for the persisted context. `Corrupt` is its own answer — unreadable
/// state is not a context, and it is not silence either.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PersistedRecord {
    Absent,
    Present(FrozenContext),
    Corrupt,
}

/// The frozen context as the renderer may read it: names and identifiers, and the times the
/// identity was proven. There is no field a token, secret, or cookie could hide in — the
/// canary test pins the exact key set, so a future field cannot sneak one in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatus {
    pub authority: String,
    pub user: ContextUser,
    pub company: Option<CompanyScope>,
    pub team: Option<TeamScope>,
    pub established_at_ms: u64,
    pub verified_at_ms: u64,
}

impl From<&FrozenContext> for ContextStatus {
    fn from(context: &FrozenContext) -> Self {
        Self {
            authority: context.authority.clone(),
            user: context.user.clone(),
            company: context.company.clone(),
            team: context.team.clone(),
            established_at_ms: context.established_at_ms,
            verified_at_ms: context.verified_at_ms,
        }
    }
}

/// Read the persisted context record. Absence, a readable record, and a corrupt record are
/// three different facts and are reported as three different values.
pub fn load_persisted(root: &Path) -> Result<PersistedRecord, Problem> {
    let Some(raw) = crate::vault::recall(root, VAULT_KEY)? else {
        return Ok(PersistedRecord::Absent);
    };
    match serde_json::from_str::<FrozenContext>(&raw) {
        Ok(context) => Ok(PersistedRecord::Present(context)),
        Err(_) => Ok(PersistedRecord::Corrupt),
    }
}

/// Persist the frozen context. The record carries identifiers and names only; the session
/// cookie stays in its own vault entry, and no serialization of this module ever contains it.
pub fn persist(root: &Path, context: &FrozenContext) -> Result<(), Problem> {
    let encoded = serde_json::to_string(context)
        .map_err(|_| Problem::plain("OpenBot could not save its organization context."))?;
    crate::vault::remember(root, VAULT_KEY, &encoded)
}

/// Freeze a context against a verified connection. The authority and the person come from the
/// connection's own verification — never from the caller. A selection is only frozen when the
/// authority's own listing can vouch for it: an unknown company, or a team under a company
/// that does not hold it, is refused rather than defaulted (spec §5.2). Establishing without
/// a selection is legitimate: the command gate still runs at organization level.
pub fn establish(
    connection: &dyn OrgConnection,
    selection: Option<&Selection>,
    now_ms: u64,
) -> Result<FrozenContext, EstablishRefusal> {
    let authority = connection.authority().to_string();
    let user = connection.verify().map_err(|failure| match failure {
        VerifyFailure::Expired => EstablishRefusal::Expired,
        VerifyFailure::Unavailable => EstablishRefusal::Unavailable,
    })?;
    let (company, team) = match selection {
        None => (None, None),
        Some(selection) => {
            let catalog = connection.scope().map_err(|failure| match failure {
                VerifyFailure::Expired => EstablishRefusal::Expired,
                VerifyFailure::Unavailable => EstablishRefusal::ListingUnavailable,
            })?;
            let listed = catalog
                .companies
                .iter()
                .find(|company| company.tenant_id == selection.tenant_id)
                .ok_or(EstablishRefusal::SelectionUnknown)?;
            let team = match &selection.workspace_id {
                None => None,
                Some(workspace_id) => {
                    let listed_team = listed
                        .teams
                        .iter()
                        .find(|team| &team.workspace_id == workspace_id)
                        .ok_or(EstablishRefusal::SelectionInvalid)?;
                    Some(TeamScope {
                        workspace_id: listed_team.workspace_id.clone(),
                        name: listed_team.name.clone(),
                    })
                }
            };
            (
                Some(CompanyScope {
                    tenant_id: listed.tenant_id.clone(),
                    name: listed.name.clone(),
                    role: listed.role.clone(),
                    member_epoch: listed.member_epoch,
                }),
                team,
            )
        }
    };
    Ok(FrozenContext {
        authority,
        user,
        company,
        team,
        established_at_ms: now_ms,
        verified_at_ms: now_ms,
    })
}

/// The production connection: the session `organization_auth` verified and saved in the
/// organization credential namespace of the organization this installation acts as, dialed
/// with the same client discipline the sign-in itself used.
#[derive(Debug)]
pub struct VerifiedConnection {
    session: auth::SavedSession,
}

impl VerifiedConnection {
    /// The saved session of this installation, or `None` before the first sign-in. The
    /// session is read from the credential namespace of the organization this installation
    /// currently acts as (MT099) — never from a personal slot, never from another
    /// organization's namespace.
    pub fn recall(root: &Path) -> Result<Option<Self>, Problem> {
        let Some(authority) = crate::credential_namespace::current_organization(root)? else {
            return Ok(None);
        };
        let Some(session) = auth::recall_session(root, &authority)? else {
            return Ok(None);
        };
        Ok(Some(Self { session }))
    }

    fn client(&self) -> Result<reqwest::blocking::Client, VerifyFailure> {
        auth::client().map_err(|_| VerifyFailure::Unavailable)
    }
}

/// A dead session (the authority said 401/403) is an identity fact; everything else that can
/// go wrong between here and the authority is infrastructure.
fn failure_of(problem: Problem) -> VerifyFailure {
    if problem.connection == Some(Connection::Organization) {
        VerifyFailure::Expired
    } else {
        VerifyFailure::Unavailable
    }
}

impl OrgConnection for VerifiedConnection {
    fn authority(&self) -> &str {
        &self.session.authority
    }

    fn verify(&self) -> Result<ContextUser, VerifyFailure> {
        let client = self.client()?;
        auth::verify(&client, &self.session)
            .map(ContextUser::from)
            .map_err(failure_of)
    }

    fn scope(&self) -> Result<CompanyCatalog, VerifyFailure> {
        let client = self.client()?;
        let response = client
            .get(format!(
                "{}/api/enterprise/workspace-scope",
                self.session.authority
            ))
            .header("cookie", &self.session.cookie)
            .send()
            .map_err(|_| VerifyFailure::Unavailable)?;
        if response.status() == 401 || response.status() == 403 {
            return Err(VerifyFailure::Expired);
        }
        // A 404 from an older deployment is the same fact as any other "no listing to vouch
        // for": a selection cannot be validated, so nothing freezes.
        if !response.status().is_success() {
            return Err(VerifyFailure::Unavailable);
        }
        response
            .json::<CompanyCatalog>()
            .map_err(|_| VerifyFailure::Unavailable)
    }
}

struct GateState {
    context: Option<FrozenContext>,
    dead: bool,
    log: Vec<RejectionRecord>,
}

/// The gate every native organization command passes. It holds one frozen context (or none)
/// and refuses anything the context does not back: a foreign authority, a scope claim the
/// freeze never made, a session that died, an identity that drifted. Every refusal is a code,
/// is recorded in a bounded ring, and is printed for the operator — values are never echoed.
pub struct Gate<'a> {
    /// Present exactly when the gate can re-verify. The sign-in gate runs on disk state
    /// alone and never checks commands, so it carries none.
    connection: Option<&'a dyn OrgConnection>,
    on_refresh: Option<Box<dyn Fn(&FrozenContext) + 'a>>,
    state: Mutex<GateState>,
}

impl<'a> Gate<'a> {
    /// The zero-network gate: disk state only. It answers exactly one question — may this
    /// installation begin a sign-in for the authority the window declared — and no command
    /// ever passes it, because freshness cannot be proven without a connection.
    pub fn from_persisted(record: PersistedRecord) -> Gate<'static> {
        let mut state = GateState {
            context: None,
            dead: false,
            log: Vec::new(),
        };
        match record {
            PersistedRecord::Absent => {}
            PersistedRecord::Corrupt => Self::record_into(&mut state, "ORG_CONTEXT_CORRUPT", 0),
            PersistedRecord::Present(context) => state.context = Some(context),
        }
        Gate {
            connection: None,
            on_refresh: None,
            state: Mutex::new(state),
        }
    }

    /// The restart gate. A persisted record is only a claim until this connection proves it:
    /// a record naming another authority is a forged persistence face and is dropped; a
    /// record the authority cannot re-prove is kept but marked dead; an unreachable authority
    /// leaves the context stale (the next check re-verifies); a proved record is refreshed —
    /// its verified time moves, and the refresh is offered back for persistence.
    pub fn load(
        connection: &'a dyn OrgConnection,
        record: PersistedRecord,
        on_refresh: Option<Box<dyn Fn(&FrozenContext) + 'a>>,
        now_ms: u64,
    ) -> Gate<'a> {
        let mut state = GateState {
            context: None,
            dead: false,
            log: Vec::new(),
        };
        let context = match record {
            PersistedRecord::Absent => None,
            PersistedRecord::Corrupt => {
                Self::record_into(&mut state, "ORG_CONTEXT_CORRUPT", now_ms);
                None
            }
            PersistedRecord::Present(persisted) => {
                if persisted.authority != connection.authority() {
                    Self::record_into(&mut state, "ORG_CONTEXT_AUTHORITY_MISMATCH", now_ms);
                    None
                } else {
                    Some(persisted)
                }
            }
        };
        state.context = context;
        let gate = Gate {
            connection: Some(connection),
            on_refresh,
            state: Mutex::new(state),
        };
        if gate.context().is_some() {
            gate.reverify(now_ms);
        }
        gate
    }

    /// May this installation begin a sign-in for `declared_authority`? Purely disk state:
    /// a context fresh on disk belongs to one authority, and a window pointed somewhere
    /// else is a client selector trying to walk the installation to another organization.
    /// Absent, corrupt, or stale state pins nobody, and the same authority may always begin.
    pub fn admit_sign_in(&self, declared_authority: &str, now_ms: u64) -> Result<(), Refusal> {
        let mut state = self.state();
        let Some(context) = &state.context else {
            return Ok(());
        };
        if now_ms.saturating_sub(context.verified_at_ms) >= REVERIFY_AFTER_MS {
            return Ok(());
        }
        if context.authority != declared_authority {
            let code = "ORG_CONTEXT_AUTHORITY_MISMATCH";
            Self::eprint(code);
            Self::record_into(&mut state, code, now_ms);
            return Err(Refusal { code });
        }
        Ok(())
    }

    /// May this command run? The compare happens before any network: a command whose
    /// authority, company, or team does not match the freeze is refused without dialing.
    /// Inside the re-verification window a fresh context passes untouched; past the window
    /// the connection must re-prove the same identity before the command proceeds.
    pub fn check(
        &self,
        requirement: Requirement,
        command: &CommandContext,
        now_ms: u64,
    ) -> Result<Grant, Refusal> {
        // The compare phase: pure decisions against the freeze, no network. It ends with the
        // frozen context to grant, or a refusal already recorded, or `None` meaning the
        // window has closed and the connection must re-prove the identity.
        let frozen = {
            let mut state = self.state();
            let Some(context) = state.context.clone() else {
                return Err(self.refuse(&mut state, "ORG_CONTEXT_REQUIRED", now_ms));
            };
            if state.dead {
                return Err(self.refuse(&mut state, "ORG_CONTEXT_EXPIRED", now_ms));
            }
            if self.connection.is_none() {
                // A gate without a connection cannot ever re-prove its context; it exists
                // for the zero-network sign-in question only. Fail closed on misuse.
                return Err(self.refuse(&mut state, "ORG_CONTEXT_UNAVAILABLE", now_ms));
            }
            if command.authority != context.authority {
                return Err(self.refuse(&mut state, "ORG_CONTEXT_AUTHORITY_MISMATCH", now_ms));
            }
            if let Some(claimed) = &command.tenant_id {
                let backed = context
                    .company
                    .as_ref()
                    .is_some_and(|company| &company.tenant_id == claimed);
                if !backed {
                    return Err(self.refuse(&mut state, "ORG_CONTEXT_COMPANY_MISMATCH", now_ms));
                }
            }
            if let Some(claimed) = &command.workspace_id {
                let backed = context
                    .team
                    .as_ref()
                    .is_some_and(|team| &team.workspace_id == claimed);
                if !backed {
                    return Err(self.refuse(&mut state, "ORG_CONTEXT_TEAM_MISMATCH", now_ms));
                }
            }
            match requirement {
                Requirement::Organization => {}
                Requirement::Company => {
                    if context.company.is_none() {
                        return Err(self.refuse(&mut state, "ORG_CONTEXT_COMPANY_REQUIRED", now_ms));
                    }
                }
                Requirement::Team => {
                    if context.company.is_none() {
                        return Err(self.refuse(&mut state, "ORG_CONTEXT_COMPANY_REQUIRED", now_ms));
                    }
                    if context.team.is_none() {
                        return Err(self.refuse(&mut state, "ORG_CONTEXT_TEAM_REQUIRED", now_ms));
                    }
                }
            }
            (now_ms.saturating_sub(context.verified_at_ms) < REVERIFY_AFTER_MS).then_some(context)
        };
        let context = match frozen {
            Some(context) => context,
            None => {
                // The guard is gone: the connection may dial. A failed re-verification is
                // either an identity fact (dead → expired) or an infrastructure fact
                // (unreachable → the context survives, unproven).
                if !self.reverify(now_ms) {
                    let mut state = self.state();
                    let code = if state.dead {
                        "ORG_CONTEXT_EXPIRED"
                    } else {
                        "ORG_CONTEXT_UNAVAILABLE"
                    };
                    return Err(self.refuse(&mut state, code, now_ms));
                }
                self.context().expect("a reverified gate holds its context")
            }
        };
        Ok(Grant {
            authority: context.authority.clone(),
            user_id: context.user.id.clone(),
            company: context.company.clone(),
            team: context.team.clone(),
        })
    }

    /// The frozen context as it stands now, if one is established. `None` means nothing:
    /// there is no default organization to report instead.
    pub fn context(&self) -> Option<FrozenContext> {
        self.state().context.clone()
    }

    /// The bounded rejection ring, oldest first.
    pub fn rejection_log(&self) -> Vec<RejectionRecord> {
        self.state().log.clone()
    }

    /// Restart or re-window verification of the gate's frozen context against this gate's
    /// connection. Success moves only the verified time and offers the refresh back; a
    /// dead session or a drifted identity marks the context dead; an unreachable
    /// authority leaves it stale for the next check to re-prove. No lock is held while the
    /// connection dials.
    fn reverify(&self, now_ms: u64) -> bool {
        let Some(context) = self.context() else {
            return false;
        };
        let Some(connection) = self.connection else {
            // The caller (check) records the right code for an unprovable context; loading
            // never reaches here because it only re-verifies an existing record.
            return false;
        };
        match connection.verify() {
            Ok(user) if user == context.user => {
                let mut refreshed = context.clone();
                refreshed.verified_at_ms = now_ms;
                let mut state = self.state();
                state.context = Some(refreshed.clone());
                if let Some(on_refresh) = &self.on_refresh {
                    on_refresh(&refreshed);
                }
                true
            }
            Ok(_) | Err(VerifyFailure::Expired) => {
                let mut state = self.state();
                state.dead = true;
                state.context = Some(context);
                false
            }
            Err(VerifyFailure::Unavailable) => false,
        }
    }

    fn refuse(&self, state: &mut GateState, code: &'static str, now_ms: u64) -> Refusal {
        Self::eprint(code);
        Self::record_into(state, code, now_ms);
        Refusal { code }
    }

    fn record_into(state: &mut GateState, code: &'static str, at_ms: u64) {
        if state.log.len() == REJECTION_LOG_CAP {
            state.log.remove(0);
        }
        state.log.push(RejectionRecord { code, at_ms });
    }

    fn eprint(code: &str) {
        eprintln!("[organization-context] refused {code}");
    }

    fn state(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A deterministic clock reading; every gate decision in these tests takes time as a
    /// parameter so no test depends on the wall clock.
    const NOW: u64 = 1_000_000_000;
    /// Past the fifteen-minute re-verification window.
    const STALE: u64 = NOW + REVERIFY_AFTER_MS + 1;

    fn user(id: &str) -> ContextUser {
        ContextUser {
            id: id.to_string(),
            email: format!("{id}@company.example"),
            name: Some("Person".to_string()),
            role: "user".to_string(),
        }
    }

    fn catalog() -> CompanyCatalog {
        CompanyCatalog {
            companies: vec![
                CatalogCompany {
                    tenant_id: "tenant-1".to_string(),
                    name: "Acme".to_string(),
                    role: "member".to_string(),
                    member_epoch: 7,
                    teams: vec![
                        CatalogTeam {
                            workspace_id: "team-1".to_string(),
                            name: "Platform".to_string(),
                        },
                        CatalogTeam {
                            workspace_id: "team-2".to_string(),
                            name: "Apps".to_string(),
                        },
                    ],
                },
                CatalogCompany {
                    tenant_id: "tenant-2".to_string(),
                    name: "Globex".to_string(),
                    role: "owner".to_string(),
                    member_epoch: 2,
                    teams: vec![CatalogTeam {
                        workspace_id: "team-9".to_string(),
                        name: "Other".to_string(),
                    }],
                },
            ],
        }
    }

    /// A stand-in for the verified organization connection: zero network, scripted answers,
    /// call counters so tests can prove a decision never dialed the authority.
    struct FakeConnection {
        authority: String,
        verify_result: Mutex<Result<ContextUser, VerifyFailure>>,
        scope_result: Mutex<Result<CompanyCatalog, VerifyFailure>>,
        verify_calls: AtomicUsize,
        scope_calls: AtomicUsize,
    }

    impl FakeConnection {
        fn new() -> Self {
            Self {
                authority: "https://company.example".to_string(),
                verify_result: Mutex::new(Ok(user("person-1"))),
                scope_result: Mutex::new(Ok(catalog())),
                verify_calls: AtomicUsize::new(0),
                scope_calls: AtomicUsize::new(0),
            }
        }

        fn with_dead_session(mut self) -> Self {
            self.verify_result = Mutex::new(Err(VerifyFailure::Expired));
            self
        }

        fn with_unreachable_authority(mut self) -> Self {
            self.verify_result = Mutex::new(Err(VerifyFailure::Unavailable));
            self
        }

        fn with_drifted_identity(mut self) -> Self {
            self.verify_result = Mutex::new(Ok(user("person-2")));
            self
        }

        fn with_unavailable_listing(mut self) -> Self {
            self.scope_result = Mutex::new(Err(VerifyFailure::Unavailable));
            self
        }

        /// The authority came back after an outage; identity as it always was.
        fn recover(&self) {
            *self.verify_result.lock().unwrap() = Ok(user("person-1"));
        }

        fn verify_calls(&self) -> usize {
            self.verify_calls.load(Ordering::SeqCst)
        }
    }

    impl OrgConnection for FakeConnection {
        fn authority(&self) -> &str {
            &self.authority
        }
        fn verify(&self) -> Result<ContextUser, VerifyFailure> {
            self.verify_calls.fetch_add(1, Ordering::SeqCst);
            self.verify_result.lock().unwrap().clone()
        }
        fn scope(&self) -> Result<CompanyCatalog, VerifyFailure> {
            self.scope_calls.fetch_add(1, Ordering::SeqCst);
            self.scope_result.lock().unwrap().clone()
        }
    }

    fn command(authority: &str) -> CommandContext {
        CommandContext {
            authority: authority.to_string(),
            tenant_id: None,
            workspace_id: None,
        }
    }

    fn claiming(tenant_id: &str, workspace_id: Option<&str>) -> CommandContext {
        CommandContext {
            authority: "https://company.example".to_string(),
            tenant_id: Some(tenant_id.to_string()),
            workspace_id: workspace_id.map(str::to_string),
        }
    }

    fn plain_gate<'a>(connection: &'a FakeConnection) -> Gate<'a> {
        Gate::load(connection, PersistedRecord::Absent, None, NOW)
    }

    fn established(connection: &FakeConnection, now_ms: u64) -> FrozenContext {
        establish(connection, None, now_ms).expect("establish without a selection")
    }

    fn established_with(
        connection: &FakeConnection,
        tenant_id: &str,
        workspace_id: Option<&str>,
    ) -> FrozenContext {
        establish(
            connection,
            Some(&Selection {
                tenant_id: tenant_id.to_string(),
                workspace_id: workspace_id.map(str::to_string),
            }),
            NOW,
        )
        .expect("establish with a listed selection")
    }

    // --- T1-T8: establish freezes what the authority verified, never what a caller said ---

    #[test]
    fn t1_establish_freezes_identity_from_the_verified_connection() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        assert_eq!(context.authority, "https://company.example");
        assert_eq!(context.user, user("person-1"));
    }

    #[test]
    fn t2_establish_without_a_selection_freezes_no_company_or_team() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        assert!(context.company.is_none());
        assert!(context.team.is_none());
    }

    #[test]
    fn t3_establish_refuses_a_company_the_authority_never_listed() {
        let connection = FakeConnection::new();
        let refusal = establish(
            &connection,
            Some(&Selection {
                tenant_id: "tenant-x".to_string(),
                workspace_id: None,
            }),
            NOW,
        )
        .expect_err("an unlisted company is not a default");
        assert_eq!(refusal.code(), "ORG_CONTEXT_SELECTION_UNKNOWN");
        assert_eq!(connection.scope_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn t4_establish_refuses_a_team_that_belongs_to_another_company() {
        let connection = FakeConnection::new();
        let refusal = establish(
            &connection,
            Some(&Selection {
                tenant_id: "tenant-1".to_string(),
                workspace_id: Some("team-9".to_string()),
            }),
            NOW,
        )
        .expect_err("team-9 belongs to tenant-2");
        assert_eq!(refusal.code(), "ORG_CONTEXT_SELECTION_INVALID");
    }

    #[test]
    fn t5_establish_freezes_company_and_team_from_the_authoritative_catalog() {
        let connection = FakeConnection::new();
        let context = established_with(&connection, "tenant-1", Some("team-2"));
        let company = context.company.expect("company frozen from the listing");
        assert_eq!(company.tenant_id, "tenant-1");
        assert_eq!(company.name, "Acme");
        assert_eq!(company.role, "member");
        assert_eq!(company.member_epoch, 7);
        let team = context.team.expect("team frozen from the listing");
        assert_eq!(team.workspace_id, "team-2");
        assert_eq!(team.name, "Apps");
        assert_eq!(context.established_at_ms, NOW);
        assert_eq!(context.verified_at_ms, NOW);
    }

    #[test]
    fn t6_establish_with_a_selection_and_no_listing_fails_closed() {
        let connection = FakeConnection::new().with_unavailable_listing();
        let refusal = establish(
            &connection,
            Some(&Selection {
                tenant_id: "tenant-1".to_string(),
                workspace_id: None,
            }),
            NOW,
        )
        .expect_err("a choice cannot be frozen against an unavailable listing");
        assert_eq!(refusal.code(), "ORG_CONTEXT_LISTING_UNAVAILABLE");
    }

    #[test]
    fn t7_establish_without_a_selection_survives_an_unavailable_listing() {
        let connection = FakeConnection::new().with_unavailable_listing();
        let context = established(&connection, NOW);
        assert!(context.company.is_none());
        assert_eq!(connection.scope_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn t8_establish_needs_a_live_session() {
        let connection = FakeConnection::new().with_dead_session();
        let refusal = establish(&connection, None, NOW)
            .expect_err("a dead session cannot freeze a context");
        assert_eq!(refusal.code(), "ORG_CONTEXT_EXPIRED");
    }

    // --- T9-T18: the gate refuses what the freeze does not back, before any network ---

    #[test]
    fn t9_a_command_without_an_established_context_is_refused() {
        let connection = FakeConnection::new();
        let gate = plain_gate(&connection);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW)
            .expect_err("nothing established means nothing allowed");
        assert_eq!(refusal.code(), "ORG_CONTEXT_REQUIRED");
    }

    #[test]
    fn t10_a_dead_context_refuses_every_command() {
        // The freeze was issued while the session lived; the session has since died. The
        // restart verification finds out, and every command after that is refused.
        let live = FakeConnection::new();
        let context = established(&live, NOW);
        let connection = FakeConnection::new().with_dead_session();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW)
            .expect_err("restart verification already failed");
        assert_eq!(refusal.code(), "ORG_CONTEXT_EXPIRED");
    }

    #[test]
    fn t11_a_foreign_authority_is_refused_before_any_network() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let baseline = connection.verify_calls();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &command("https://evil.example"), NOW + 1)
            .expect_err("a forged authority names a connection this context never belonged to");
        assert_eq!(refusal.code(), "ORG_CONTEXT_AUTHORITY_MISMATCH");
        assert_eq!(
            connection.verify_calls(),
            baseline + 1,
            "only the load re-verification dialed; the forgery face dials nobody"
        );
    }

    #[test]
    fn t12_a_company_claim_the_freeze_never_made_is_refused() {
        let connection = FakeConnection::new();
        let scoped = established_with(&connection, "tenant-1", None);
        let gate = Gate::load(&connection, PersistedRecord::Present(scoped), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &claiming("tenant-2", None), NOW + 1)
            .expect_err("the freeze says Acme, the command says Globex");
        assert_eq!(refusal.code(), "ORG_CONTEXT_COMPANY_MISMATCH");

        // A context established without any company refuses every company claim.
        let bare = established(&connection, NOW);
        let gate = Gate::load(&connection, PersistedRecord::Present(bare), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &claiming("tenant-1", None), NOW + 1)
            .expect_err("a claim cannot attach itself to a context that never chose one");
        assert_eq!(refusal.code(), "ORG_CONTEXT_COMPANY_MISMATCH");
    }

    #[test]
    fn t13_a_team_claim_outside_the_freeze_is_refused() {
        let connection = FakeConnection::new();
        let scoped = established_with(&connection, "tenant-1", Some("team-1"));
        let gate = Gate::load(&connection, PersistedRecord::Present(scoped), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &claiming("tenant-1", Some("team-2")), NOW + 1)
            .expect_err("the freeze says Platform, the command says Apps");
        assert_eq!(refusal.code(), "ORG_CONTEXT_TEAM_MISMATCH");
    }

    #[test]
    fn t14_refusals_are_recorded_with_a_code_and_a_time_and_no_values() {
        let connection = FakeConnection::new();
        let gate = plain_gate(&connection);
        let _ = gate.check(Requirement::Organization, &command("https://evil.example"), NOW);
        let _ = gate.check(Requirement::Organization, &command("https://company.example"), NOW + 5);
        let log = gate.rejection_log();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].code, "ORG_CONTEXT_REQUIRED");
        assert_eq!(log[0].at_ms, NOW);
        assert_eq!(log[1].at_ms, NOW + 5);
        // No refusal record ever carries a claimed value.
        let serialized = serde_json::to_string(&log).unwrap();
        assert!(!serialized.contains("evil.example"));
        assert!(!serialized.to_lowercase().contains("token"));
    }

    #[test]
    fn t15_the_rejection_log_is_bounded_and_evicts_the_oldest() {
        let connection = FakeConnection::new();
        let gate = plain_gate(&connection);
        for step in 0..70u64 {
            let _ = gate.check(Requirement::Organization, &command("https://company.example"), NOW + step);
        }
        let log = gate.rejection_log();
        assert_eq!(log.len(), REJECTION_LOG_CAP);
        assert_eq!(log[0].at_ms, NOW + 70 - REJECTION_LOG_CAP as u64);
        assert_eq!(log.last().unwrap().at_ms, NOW + 69);
    }

    #[test]
    fn t16_a_fresh_context_passes_without_touching_the_network() {
        let connection = FakeConnection::new();
        let context = established_with(&connection, "tenant-1", Some("team-1"));
        let baseline = connection.verify_calls();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let grant = gate
            .check(Requirement::Team, &claiming("tenant-1", Some("team-1")), NOW + 1_000)
            .expect("a fresh, matching command runs");
        assert_eq!(grant.authority, "https://company.example");
        assert_eq!(grant.user_id, "person-1");
        assert_eq!(grant.company.expect("grant carries the frozen company").tenant_id, "tenant-1");
        assert_eq!(grant.team.expect("grant carries the frozen team").workspace_id, "team-1");
        assert_eq!(
            connection.verify_calls(),
            baseline + 1,
            "only the load re-verification dialed; inside the window nothing more is dialed"
        );
    }

    #[test]
    fn t17_a_stale_context_reverifies_and_advances_only_the_timestamp() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let baseline = connection.verify_calls();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let grant = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect("the authority re-proved the same identity");
        assert_eq!(grant.user_id, "person-1");
        assert_eq!(
            connection.verify_calls(),
            baseline + 2,
            "one dial by the load, one by the window"
        );
        let refreshed = gate.context().expect("still established");
        assert_eq!(refreshed.verified_at_ms, STALE);
        assert_eq!(refreshed.established_at_ms, NOW, "freezing time never moves");
        assert_eq!(refreshed.user, user("person-1"), "identity is byte-identical");
    }

    #[test]
    fn t18_reverification_catches_identity_drift_and_marks_the_context_dead() {
        let connection = FakeConnection::new().with_drifted_identity();
        let context = established(&FakeConnection::new(), NOW);
        let baseline = connection.verify_calls();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect_err("the authority now answers for a different person");
        assert_eq!(refusal.code(), "ORG_CONTEXT_EXPIRED");
        // Death is remembered: the next command refuses without dialing again.
        let again = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE + 1);
        assert_eq!(again.unwrap_err().code(), "ORG_CONTEXT_EXPIRED");
        assert_eq!(
            connection.verify_calls(),
            baseline + 1,
            "a dead context does not dial"
        );
    }

    // --- T19-T24: restart consistency; nothing falls back to a default organization ---

    #[test]
    fn t19_a_restart_with_a_live_session_loads_verified_and_persists_the_refresh() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let raw = serde_json::to_string(&context).unwrap();
        let restored: FrozenContext = serde_json::from_str(&raw).unwrap();
        let refreshes: std::rc::Rc<std::cell::RefCell<Vec<FrozenContext>>> = Default::default();
        let sink = refreshes.clone();
        let gate = Gate::load(
            &connection,
            PersistedRecord::Present(restored),
            Some(Box::new(move |refreshed| sink.borrow_mut().push(refreshed.clone()))),
            STALE,
        );
        let grant = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect("the same person is back after the restart");
        assert_eq!(grant.user_id, "person-1");
        assert_eq!(refreshes.borrow().len(), 1, "the refresh is offered for persistence");
        assert_eq!(refreshes.borrow()[0].verified_at_ms, STALE);
    }

    #[test]
    fn t20_a_restart_with_a_dead_session_refuses_commands() {
        let connection = FakeConnection::new().with_dead_session();
        let context = established(&FakeConnection::new(), NOW);
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, STALE);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect_err("the session the freeze trusted is gone");
        assert_eq!(refusal.code(), "ORG_CONTEXT_EXPIRED");
    }

    #[test]
    fn t21_a_restart_that_verifies_a_different_identity_refuses_commands() {
        let connection = FakeConnection::new().with_drifted_identity();
        let context = established(&FakeConnection::new(), NOW);
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, STALE);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect_err("a restart never silently adopts a new identity");
        assert_eq!(refusal.code(), "ORG_CONTEXT_EXPIRED");
    }

    #[test]
    fn t22_a_restart_during_an_outage_stays_stale_and_recovers_without_refreezing() {
        let connection = FakeConnection::new().with_unreachable_authority();
        let context = established(&FakeConnection::new(), NOW);
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, STALE);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect_err("an unreachable authority cannot be trusted blind");
        assert_eq!(refusal.code(), "ORG_CONTEXT_UNAVAILABLE");
        // The outage is not an identity fact: when the authority answers again, the same
        // frozen context resumes — it is never silently replaced.
        connection.recover();
        let grant = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE + 1)
            .expect("the same context resumes when the authority is reachable");
        assert_eq!(grant.user_id, "person-1");
    }

    #[test]
    fn t23_a_corrupt_persisted_record_loads_nothing_and_is_recorded() {
        let connection = FakeConnection::new();
        let gate = Gate::load(&connection, PersistedRecord::Corrupt, None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW)
            .expect_err("unreadable state is not a context");
        assert_eq!(refusal.code(), "ORG_CONTEXT_REQUIRED");
        assert_eq!(gate.rejection_log()[0].code, "ORG_CONTEXT_CORRUPT");
    }

    #[test]
    fn t24_a_persisted_record_from_another_connection_is_forged_and_dropped() {
        let connection = FakeConnection::new();
        let mut context = established(&connection, NOW);
        context.authority = "https://other.example".to_string();
        let gate = Gate::load(&connection, PersistedRecord::Present(context), None, NOW);
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW)
            .expect_err("a record naming another authority never becomes this connection's context");
        assert_eq!(refusal.code(), "ORG_CONTEXT_REQUIRED");
        assert_eq!(gate.rejection_log()[0].code, "ORG_CONTEXT_AUTHORITY_MISMATCH");
    }

    // --- T25: the renderer-facing DTO carries no secret material ---

    #[test]
    fn t25_the_status_dto_has_no_field_for_any_secret() {
        let connection = FakeConnection::new();
        let context = established_with(&connection, "tenant-1", Some("team-1"));
        let status = ContextStatus::from(&context);
        let json = serde_json::to_value(&status).unwrap();
        let top = json.as_object().unwrap();
        let mut keys: Vec<_> = top.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["authority", "company", "establishedAtMs", "team", "user", "verifiedAtMs"]
        );
        let user_keys: Vec<_> = top["user"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(user_keys, vec!["email", "id", "name", "role"]);
        let company_keys: Vec<_> =
            top["company"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(company_keys, vec!["memberEpoch", "name", "role", "tenantId"]);
        let team_keys: Vec<_> = top["team"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(team_keys, vec!["name", "workspaceId"]);
        let rendered = serde_json::to_string(&status).unwrap().to_lowercase();
        for forbidden in ["token", "secret", "cookie"] {
            assert!(!rendered.contains(forbidden), "{forbidden} leaked into the DTO");
        }
        // A command payload naming a field the model never declared is refused at the door.
        let smuggled = serde_json::json!({
            "authority": "https://company.example",
            "tenantId": "tenant-1",
            "cookie": "better-auth.session_token=stolen"
        });
        assert!(serde_json::from_value::<CommandContext>(smuggled).is_err());
    }

    // --- T26-T27: the sign-in gate keeps one installation on one organization ---

    #[test]
    fn t26_the_sign_in_gate_refuses_a_begin_declared_for_another_organization() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let gate = Gate::from_persisted(PersistedRecord::Present(context));
        let refusal = gate
            .admit_sign_in("https://evil.example", NOW + 1_000)
            .expect_err("a client selector may not walk a live context to another authority");
        assert_eq!(refusal.code(), "ORG_CONTEXT_AUTHORITY_MISMATCH");
    }

    #[test]
    fn t27_the_sign_in_gate_admits_absent_stale_and_same_authority_begins() {
        let connection = FakeConnection::new();
        // Nothing on disk: the ordinary first sign-in.
        let gate = Gate::from_persisted(PersistedRecord::Absent);
        gate.admit_sign_in("https://company.example", NOW)
            .expect("no context admits any begin");
        // Corrupt state cannot vouch for anybody.
        let gate = Gate::from_persisted(PersistedRecord::Corrupt);
        gate.admit_sign_in("https://company.example", NOW)
            .expect("corrupt state admits a recovery sign-in");
        // A context stale on disk belongs to a past process; begin is the way back.
        let context = established(&connection, NOW);
        let gate = Gate::from_persisted(PersistedRecord::Present(context));
        gate.admit_sign_in("https://evil.example", STALE)
            .expect("a stale context no longer pins the installation");
        // The same organization signing in again is a refresh, not a switch.
        let context = established(&connection, NOW);
        let gate = Gate::from_persisted(PersistedRecord::Present(context));
        gate.admit_sign_in("https://company.example", NOW + 1_000)
            .expect("the same authority may begin again");
    }

    // --- T28-T29: no default organization, ever; a gate that cannot verify cannot pass ---

    #[test]
    fn t28_an_installation_with_no_context_has_no_status_and_no_default() {
        let connection = FakeConnection::new();
        let gate = Gate::load(&connection, PersistedRecord::Absent, None, NOW);
        assert!(gate.context().is_none(), "absent means absent, not a first company");
    }

    #[test]
    fn t29_a_gate_with_no_connection_cannot_prove_freshness_and_refuses() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let gate = Gate::from_persisted(PersistedRecord::Present(context));
        let refusal = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW + 1)
            .expect_err("without a connection no freshness can be proven");
        assert_eq!(refusal.code(), "ORG_CONTEXT_UNAVAILABLE");
    }

    // --- T30-T32: the persisted record and the production connection ---

    #[test]
    fn t30_the_persisted_record_round_trips_and_corruption_is_classified() {
        let root = temp_root("org-context-persist");
        let connection = FakeConnection::new();
        let context = established_with(&connection, "tenant-1", Some("team-1"));
        persist(&root, &context).expect("the frozen context persists without secret values");
        assert_eq!(
            load_persisted(&root).unwrap(),
            PersistedRecord::Present(context.clone())
        );
        std::fs::remove_dir_all(&root).expect("remove owned persistence fixture");

        let root = temp_root("org-context-corrupt");
        persist(&root, &context).expect("write before corrupting");
        crate::vault::remember(&root, VAULT_KEY, "not a context").unwrap();
        assert_eq!(load_persisted(&root).unwrap(), PersistedRecord::Corrupt);
        std::fs::remove_dir_all(&root).expect("remove owned persistence fixture");

        let root = temp_root("org-context-absent");
        assert_eq!(load_persisted(&root).unwrap(), PersistedRecord::Absent);
        std::fs::remove_dir_all(&root).expect("remove owned persistence fixture");
    }

    #[test]
    fn t31_a_catalog_row_outside_the_listing_never_freezes() {
        let connection = FakeConnection::new();
        // The listing is the only source of company facts: a fabricated epoch or role cannot
        // enter the freeze because establish copies from the catalog, never from the selection.
        let context = established_with(&connection, "tenant-2", None);
        let company = context.company.unwrap();
        assert_eq!(company.name, "Globex");
        assert_eq!(company.role, "owner");
        assert_eq!(company.member_epoch, 2);
        assert!(context.team.is_none());
    }

    #[test]
    fn t32_reverification_that_persists_uses_the_offered_callback_not_its_own_writes() {
        let connection = FakeConnection::new();
        let context = established(&connection, NOW);
        let refreshes: std::rc::Rc<std::cell::RefCell<Vec<FrozenContext>>> = Default::default();
        let sink = refreshes.clone();
        let gate = Gate::load(
            &connection,
            PersistedRecord::Present(context),
            Some(Box::new(move |refreshed| sink.borrow_mut().push(refreshed.clone()))),
            NOW,
        );
        // Loading a record always re-verifies, so the load itself offered one refresh.
        assert_eq!(refreshes.borrow().len(), 1, "the load's refresh is offered for persistence");
        let _ = gate
            .check(Requirement::Organization, &command("https://company.example"), NOW + 1_000)
            .expect("inside the window");
        assert_eq!(
            refreshes.borrow().len(),
            1,
            "no re-verification, no callback"
        );
        let _ = gate
            .check(Requirement::Organization, &command("https://company.example"), STALE)
            .expect("re-verified");
        assert_eq!(refreshes.borrow().len(), 2);
        assert_eq!(refreshes.borrow()[1].verified_at_ms, STALE);
    }

    // --- T33 (MT099): the production connection's storage face follows the current organization ---

    #[test]
    fn t33_recall_reads_the_session_of_the_organization_the_installation_actually_stored() {
        let root = temp_root("org-context-recall-current");
        // No organization stored yet: no connection.
        assert!(VerifiedConnection::recall(&root).unwrap().is_none());
        // After a sign-in completes (its session lands in the namespace and the pointer
        // moves), the production connection is the one the installation stored.
        crate::organization_auth::store_session(
            &root,
            "https://company.example",
            &crate::organization_auth::SavedSession {
                authority: "https://company.example".to_string(),
                cookie: "better-auth.session_token=fixture".to_string(),
            },
        )
        .unwrap();
        let connection = VerifiedConnection::recall(&root)
            .unwrap()
            .expect("the stored organization's session");
        assert_eq!(connection.authority(), "https://company.example");
        // A corrupt namespace entry is a dead sign-in, not a silent fallback.
        crate::credential_namespace::org_remember(
            &root,
            "https://company.example",
            crate::credential_namespace::SESSION_CREDENTIAL,
            "not a session",
        )
        .unwrap();
        let refused = VerifiedConnection::recall(&root).unwrap_err();
        assert_eq!(
            refused.connection,
            Some(crate::problem::Connection::Organization)
        );
        std::fs::remove_dir_all(&root).expect("remove owned recall fixture");
    }
}
