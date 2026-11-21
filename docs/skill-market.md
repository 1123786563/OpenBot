# Deploy the SkillHub catalog

OpenBot's team edition can show an administrator-curated catalog under **Capabilities → Skills → Skill market**. All signed-in deployment users see the same catalog. Leave the SkillHub settings empty to disable the feature.

## Configure SkillHub

1. Deploy [SkillHub v0.2.28](https://github.com/iflytek/skillhub/releases/tag/v0.2.28) separately. The release commit is `b81af32f145c393c03051865031eae7bfbeaafa4`. The verified server image digest is `sha256:27765c14803bbd580866d44ccaaaacaf482dd29336979f41bd8d44927d817b61`. The verified scanner image digest is `sha256:6fb1e0e194150bea357f733881c8a073983b675358c0b5f781b847dec60c63fc`.
2. Enable the security scanner and use `SKILLHUB_STORAGE_PROVIDER=local` so the exact-version download returns a ZIP directly. OpenBot requires a direct ZIP response from the configured origin.
3. Create a dedicated team namespace. Publish curated skills as **Namespace only**. Keep other content in a separate restricted namespace. Disable team auto-publication for the catalog's publishers and have reviewers approve each version in SkillHub.
4. Create a regular account dedicated to catalog reads. Add it to that namespace as **Member** and issue an API token with only `skill:read`. Give the account membership only in this namespace and keep publishing and moderation credentials separate.

## Configure OpenBot

| Server setting | Value |
| --- | --- |
| `SKILLHUB_URL` | SkillHub HTTP origin reachable from the OpenBot server. Use HTTPS when traffic crosses a network you do not control. |
| `SKILLHUB_CATALOG_NAMESPACE` | Slug of the dedicated SkillHub team namespace. |
| `SKILLHUB_READ_TOKEN` | The dedicated reader's bearer token. Store it in a deployment secret. |
| `SKILLHUB_COMPATIBILITY_CONFIRMATIONS` | Optional JSON array of the administrator's exact-version confirmations. Defaults to an empty array. |

The Compose server reads these settings from its `.env`. For Helm, put the settings in an existing Secret and attach it to the server through `config.extraEnvFrom`.

```yaml
config:
  extraEnvFrom:
    - secretRef:
        name: openbot-skillhub
```

Restart OpenBot after changing catalog settings.

## Declare and confirm compatibility

A publisher adds the following to the `SKILL.md` frontmatter of each version. Set each field to the actual requirement. The optional top-level `compatibility` string can describe additional runtime requirements and will be shown in the preview.

```yaml
metadata:
  openbot-compatibility:
    scripts: false
    supportingFiles: false
    dedicatedRuntime: false
```

A reviewer checks the exact submitted package and records the compatibility decision in the SkillHub moderation comment. For a confirmed version, a deployment administrator checks the approved task's version ID, reviewer and comment. The administrator reads the exact version's fingerprint from `GET /api/v1/skills/{namespace}/{slug}/resolve?version={version}` and records these fields in the deployment setting.

```json
[
  {
    "slug": "summarize",
    "version": "1.0.0",
    "versionId": 1,
    "fingerprint": "sha256:9c1174a2e400e3ab88c13569c8cf2d29bc645a2f2fd53ff188fa13cefff54ed3",
    "reviewTaskId": 1,
    "reviewerId": "docker-admin"
  }
]
```

The deployment configuration is the trusted copy of the reviewer decision. SkillHub's reader API returns publisher metadata and publication status. Its moderation endpoints require a separate privileged identity. The catalog reader gets no moderation access. OpenBot requires the version ID, coordinate and package fingerprint to match the confirmed package. The preview gives specific reasons when the declaration is missing or invalid, the confirmation is absent, or the package requires an unsupported component. The first release supports a package with only one root `SKILL.md` and no additional runtime requirements.

## Verification on v0.2.28

The isolated release used PostgreSQL, Redis, the release scanner, and local package storage. A publisher submitted `catalog119/summarize@1.0.0`, and a separate reviewer recorded “OpenBot compatibility confirmed.” in approved moderation task 1. The version details exposed the publisher's declaration inside `parsedMetadataJson.frontmatter`. The approved record exposed the reviewer and comment to the moderation session.

| Request with the dedicated `skill:read` token | Observed |
| --- | --- |
| Catalog search, detail, exact-version metadata, resolution and ZIP download | HTTP 200. The ZIP contained the approved `SKILL.md`. |
| Detail, version or ZIP for a skill in a different restricted namespace | HTTP 403. The other skill was absent from catalog search. |
| Unpublished version metadata and ZIP | HTTP 400 and 403 respectively. |
| Publish, read a moderation record, or approve | HTTP 403. |

Two independent Better Auth sessions exercised the OpenBot Web API and the bundled market component in separate Chromium contexts against this live registry. Both could search, select and preview version 1.0.0, and download its ZIP through the API. Both could preview 3.0.0 (unconfirmed), 4.0.0 (no declaration), and 5.0.0 (scripts, supporting files, and dedicated runtime required). The Web component displayed the corresponding reasons. Direct requests for the out-of-catalog and unpublished versions returned HTTP 404.
