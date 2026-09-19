# T3 Code Personal

This fork tracks published upstream nightlies with a small personal keep list:

- Compact web and mobile composers and brighter text.
- Expanded transcripts for agents created through a provider's native delegation.
- Native Codex/Claude side chats with full-screen mobile navigation.
- Codex goal controls, including `/goal`, budgets, pause, resume, and clear.
- Personal Windows x64/ARM64 installers and iPhone preview builds.
- iPhone push alerts for completed turns, failures, and requests for input or approval.
- The release and sync automation needed to maintain those builds.

Everything else follows upstream. The previous fork is archived at
`archive/pre-simplification-20260908` for historical reference. Its cross-provider delegation, account management, task observability,
private-feed authentication, and in-app merge notices are outside the maintained
scope. The [native transcript guide](docs/user/agent-transcripts.md) describes the
retained agent view.

Side chats remain visible in the normal thread list. Related chats link their parents,
children, and siblings without adding panels to the mobile composer. Saved agent messages retain their
transcript attribution. Saved goals remain available, and requests belonging
to the removed cross-provider bridge no longer offer active controls. The database
upgrade preserves the old migration ledger while returning to upstream numbering.

## Windows releases

[Releases](https://github.com/Simcity400/t3code-personal/releases) contains unsigned
**T3 Code (Nightly)** installers for x64 and ARM64. The public update feed uses the
upstream GitHub updater support. Installer selection follows the native host CPU,
including ARM64 recovery when the current app runs under x64 emulation.

The release workflow packages both architectures and merges their update manifests.
It verifies all installers, blockmaps, and manifests before publishing the draft.
The runtime bundle probe runs on matching Windows architectures; a cross-built
ARM64 payload cannot load its native addons in the x64 runner's Node process.
Static payload validation still applies to both builds.

The optional root setup helper remains available and requires GitHub CLI login.
The `FORK_WSL_PTY` repository variable enables bundling the WSL terminal backend
when set to `true`; it is omitted from personal builds by default.

## iPhone preview

Personal iPhone builds use the Expo preview profile and branch. The pipeline compares
native fingerprints, publishes an OTA update when a compatible runtime exists, and
starts a native build when inputs change. Install the new preview build after a
native change. `EXPO_TOKEN` is required in the repository's Actions secrets.

Personal signing uses a different Apple bundle and team from the official app.
The preview app registers with connected environments, which send agent alerts
through Expo using the preview project's push credentials. Enable notifications
in the app's Settings, then open the app and connect to each updated environment.
Settings shows whether those environments accepted the registration, names the error
when the build cannot obtain a push token, and offers **Send Test Alert**, which asks
every connected environment to push once and reports Expo's answer per environment.
Live Activities remain unavailable in the personal preview because they require a
separate APNs relay.

## Upstream sync and checks

Four workflows are retained:

| Workflow                  | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `fork-sync.yml`           | Integrate published official nightlies and trigger personal releases. |
| `fork-release.yml`        | Check and package Windows x64/ARM64 builds.                           |
| `fork-mobile-preview.yml` | Publish compatible iPhone updates or create a native preview build.   |
| `fork-checks.yml`         | Check retained regressions and scan application source for secrets.   |

`fork-upstream.json` records the integrated official tag and commit. Source package
versions stay upstream-owned; the Windows pipeline stamps personal versions during
packaging. Sync preserves the four-workflow allowlist and stops on code conflicts.
Failures and conflicting files appear in the Actions run log, with a summary directing
maintainers to the failed sync step. The last successful release remains available until a
maintainer resolves the conflict and the pipeline succeeds.

Use `origin` for this fork and `upstream` for the official repository. Upstream docs
are retained for shared features and architecture; their release procedures describe
the official project. Keep personal installation and maintenance guidance here and
in [README.md](README.md).
