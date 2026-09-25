# T3 Code Personal

This fork follows T3 Code with these personal additions:

- Subagent panel and transcripts, with a dedicated mobile view. The panel loads the
  thread's full history by itself, and older chat turns load when you scroll to the top,
  so there is no "Load earlier" button.
- Personal iPhone notifications and Live Activities sent directly from your T3 server
  (see `docs/operations/personal-iphone-push.md`). The official relay cannot sign pushes
  for this fork's bundle ID.
- Personal Windows x64/ARM64 updates and iPhone preview releases.
- Automatic nightly integration and an in-app action to resolve blocked merges.

Everything else follows upstream. The earlier fork is archived at
`archive/pre-simplification-20260908` for reference. Database compatibility keeps
databases written by earlier fork builds readable, including events and columns from
removed features, without taking over upstream's migration numbering.

## Windows updates

[Releases](https://github.com/Simcity400/codegui/releases) contains unsigned
**T3 Code (Nightly)** installers. Install the version for your machine, then use the
app's normal update controls. Updates select the native Windows CPU architecture,
including ARM64 when an older installation runs under x64 emulation.

The release pipeline runs focused regression checks, builds on native x64 and ARM64
runners, and verifies both installers, blockmaps, and update manifests before
publishing. Personal builds do not bundle the optional WSL runtime.

## iPhone preview

The preview uses Expo project `1ea2f814-b9d5-48ab-b427-19b4e3d384b1` owned by
`simcity400`, bundle ID `com.simcity400.t3code.preview`, and Apple team `X8R35QF7WN`.
The repository requires an `EXPO_TOKEN` Actions secret with access to that project
and valid iOS preview signing credentials in EAS.

Changes publish to the `preview` branch. The pipeline compares native fingerprints:
compatible changes ship over the air; native changes require installing the new
preview build from EAS. Native builds wait at least three days between attempts
and stop when the `simcity400` account has used its iPhone builds for the current
Expo billing period (15 on the free plan), so they never incur overage. If the
token cannot read account usage, a stricter fallback applies: 12 attempts of any
outcome in a rolling 31-day window.

A daily check retries deferred native changes from the latest `main`; Windows
releases and compatible over-the-air updates continue independently. While a native
build is deferred, the installed app keeps its last compatible update. GitHub's
workflow summary explains any delay. For an urgent native update, run **Personal
iPhone Preview** manually with **urgent_native_build** checked. This bypasses the
three-day wait, but still respects the cap and avoids overlapping EAS builds.

## Upstream sync

**Fork Sync** checks for published official nightlies every 15 minutes (GitHub may
delay scheduled runs). It merges the published tag into `main`, records it in
`fork-upstream.json`, and explicitly starts Windows and iPhone releases. Direct
pushes also trigger the relevant releases. Package versions stay upstream-owned;
Windows packaging stamps a personal nightly version.

Only the four `fork-*.yml` workflows run here. Official workflows depend on T3's
runners, deployment targets, and credentials; the sync removes them during merges.
Real code conflicts stop the sync without replacing either side. The installed
desktop app displays **Official update needs a merge** with **Finish with an agent**,
which prepares a repair prompt in a new thread. Review and send it to resolve the
conflict. The last successful release remains available until repairs pass checks
and publish. A later successful sync clears the notice.

Use `origin` for this fork and `upstream` for `pingdotgg/t3code`. The upstream docs
describe shared features and architecture; their official release procedures do
not configure these personal pipelines.
