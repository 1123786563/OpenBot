# OpenConnector

OpenConnector is a broker this deployment runs itself. It is a container — the `open-connector`
service in this repository's `docker-compose.yml` — that proxies a catalogue of apps and holds each
person's credentials for them, so a Bot can act in GitHub or Firecrawl or the long tail behind them
without this deployment registering an OAuth client with each vendor. What makes it unlike Composio
is where the credentials live: not at a vendor's cloud, but in this deployment's own volume, next to
the database it already protects. A Bot with a brokered action granted reaches the app **as the
person asking**, the same as every other per-person connector here.

Setting it up takes three hands, and none of them can do another's:

| Who              | Does                                                                        | Where                                                            |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Whoever deploys  | Sets `OPENCONNECTOR_ADMIN_TOKEN`, `OPENCONNECTOR_RUNTIME_TOKEN` and `OPENCONNECTOR_ENCRYPTION_KEY`, and starts the `open-connector` service | The deployment's environment and its Compose stack. There is no screen for any of it |
| An administrator | Enables an app                                                              | `/admin/plugins/open-connector`                                  |
| An administrator | Grants its actions to a Bot                                                 | The app's own page, then that page's per-Bot screen              |
| Each person      | Connects their own account to that app                                      | `/settings/connected-accounts`                                   |

## The two tokens

The container has two faces and separates them itself: the management endpoints that read the
directory and hold the connections answer to `OPENCONNECTOR_ADMIN_TOKEN`, and the execution face
that runs an action answers to `OPENCONNECTOR_RUNTIME_TOKEN`. The server treats the broker as
configured only when **both** are set, and reaches it at `OPENCONNECTOR_URL` —
`http://localhost:3100` by default, which is where the Compose service publishes it, on loopback
only, so nothing off this machine can try either token. The address is validated at boot: it must
be an absolute `http://` or `https://` origin carrying no user info, and a bad one stops the boot
that mis-set it rather than waiting for somebody's connect attempt to find out.

Unset tokens are a supported, fully described state rather than a degraded one. What is on screen
then is exactly one row, on `/admin/plugins` under the **More apps** heading, titled *OpenConnector*
and reading *Run the open-connector container to enable a self-hosted catalogue of apps. Set
OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN on this deployment.* It has no chevron and
it is not a link, because there is no directory to browse until the container is running and both
tokens are set.

`OPENCONNECTOR_ENCRYPTION_KEY` is the third variable, and it belongs to the container rather than
the server: handed in as `OOMOL_CONNECT_ENCRYPTION_KEY`, it makes the container encrypt the
credentials it writes to its `/app/data` volume with AES-256-GCM. A deployment that leaves it unset
still works; what people type then rests unencrypted on that volume, which is worth deciding before
the first connection rather than after it.

## What an administrator does

### 1. Find the app, and read its action count

At `/admin/plugins/open-connector`, search the container's directory. The directory is read whole
and searched in this process, so what is on screen is a complete listing and not a page of one — and
nothing in it has been reviewed by this deployment, the page says so, because a self-hosted
catalogue is whatever its container's version carries. Each row carries the app's **action count**,
which is worth reading before pressing **Add** for the same reason it is on Composio's directory:
there is no cap, and grants remain the only ceiling.

### 2. Enable the app

**Add** takes the slug the directory itself answered with — a slug that arrived from anywhere else
is refused, because it would become the address every future call for the app runs in. The result is
one ordinary `mcp_servers` row — id `open-connector-<slug>`, url `openconnector://<slug>`,
provenance `open-connector`, no credential of any kind — and then the app's actions. OpenConnector
publishes no behaviour labels, so every one of its actions is recorded as a **write**: nothing
renders as a safe read, a person's ask-before-write switch and any approval rule apply to every call
alike, and the enable screen says which actions rather than how safe they are.

Nothing arrives switched on. Enabling an app names no Bot, and a grant nobody made is not drawn as
though it had been.

### 3. Grant actions to a Bot

From the app's page, open one Bot to get the screen listing every action with a switch each. Every
call then checks the grant, evaluates the action policy, and writes an audit row — the same surface
every other connector here runs on, with `provenance: "open-connector"` on the trail.

## The ways an app connects

Phase 1 drives two kinds, and refuses the third rather than pretending to offer it:

| The provider says    | What Connect asks                                              |
| -------------------- | -------------------------------------------------------------- |
| `api_key`            | One or more boxes, typed by the person connecting              |
| `custom_credential`  | The same: whatever fields the provider declares                |
| `no_auth`            | Nothing, ever. There is no account to make                     |
| `oauth2`             | Not offered — see below                                        |

**A key app never leaves OpenBot.** Connect opens a form whose boxes are the provider's own — their
names, labels and which of them are secret are published by the container and used verbatim, and a
field that cannot be read as text is a refusal rather than a box drawn blind. What is typed goes to
the container on that one request and is never written here: not to a table, a log line, an error
body or an audit row, which records the field *names* and never a value.

**A key is accepted without being checked, and the row says so.** Composio labels its actions so a
safe read can be spent finding out whether a key works; OpenConnector publishes nothing of the kind,
so there is no action this deployment could honestly probe a key with — and an unlabelled action is
a write, which a probe must not be. The connection is therefore recorded as accepted-unchecked, no
Re-check button is drawn for it, and the remedy the row names is the honest one: disconnect and
connect again with a fresh key.

**A no-auth app needs no account at all.** Its row on a connected-accounts page says so and carries
no button, and a Bot granted its tools uses it as it is.

**An OAuth app is not offered, and that is a non-goal rather than an oversight.** A consent-screen
app wants an OAuth client registered with the vendor — a client id and secret this deployment has
nowhere to hold, for the reasons [composio.md's section on its own not-offered
apps](./composio.md#the-56-that-are-not-offered) sets out at length. `oauth2` providers arrive as
`unsupported`, the picker hides them, and a request naming one by hand is refused with that reason
before anything is written.

## How people are kept apart

OpenConnector is single-tenant and keeps people apart by named connections, so this deployment mints
the names: one alias per person per app (`openbot-u-<user>-<service>`), derived from ids it already
trusts and never from anything a request said. The alias is what a call runs under and what
disconnect ends — there is exactly one account per person per app, and a second is refused with the
way to switch.

## Disconnecting

**Disconnect** deletes the named connection at the container and then the row here — revoke first,
so a failure between the two leaves access dead rather than live and unreachable. For a key app that
withdrawal reaches only the container: **the key still works at the vendor**, and the page says so
rather than letting *disconnected* be read as *revoked — rotate the key at the vendor if you meant
to end its access.* Removing the app, or removing the person, revokes each connection the same way,
by its alias.

## Blast radius

One container inside this deployment. Everything a person types into it stays in that container's
volume, and the encryption key that protects the volume is the deployment's own to set and keep.
The contrast with [Composio](./composio.md#blast-radius) is the whole reason this broker exists:
there, one vendor ends up holding every person's connection to every app; here, the radius is a
container, a volume and a key that this deployment already owns — and nobody outside this machine
can reach any of it, because the container publishes on loopback only.

## See also

- [Composio](./composio.md) — the same per-person shape behind a vendor's cloud, and the section on
  the apps that want an OAuth client registered, which is why consent apps are not offered here
  either.
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENCONNECTOR_*`, and that all of it is optional.
