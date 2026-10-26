# Browser CoreCLR prototype tools

**Maintained, local-only reproduction tools; not a portable-runtime acceptance claim.** The carry-forward source is on [Steve's dedicated carry-forward branch](https://github.com/steveisok/vscode-csharp/tree/steveisok-wasm-debugger-carry-forward). Pin its full immutable commit from the matching canonical guide manifest rather than a moving branch tip. The ancestor `d48a1531e6c045784bfe646b8d4662e4f579dbcc` identifies the earlier published extension base, not this carry-forward revision; that base's portability phase ran configuration/reporting tests rather than a new debugger pilot.

The fresh macOS arm64 follow-up passed bounded Small and Havit capability checks with the complete **unmodified** Concord producer built from `1936807ad9dc0bf85cc6bfbf76c8d34222e11c55`, using its direct publish directory. The separate native long-path patch is not required for those observed component paths (197/193 characters); this does not negate the old long-path defect or establish arbitrary path/platform support. Earlier fresh timing measurements used the **patched** native package and remain labeled that way, not retroactively unmodified measurements. Windows/Linux and macOS x64 still require matching native components and their own pilots.

The canonical private build/source guide lives in the access-restricted [internal-components repository](https://dnceng.visualstudio.com/internal/_git/dotnet-diagnostics-internal-components), at `docs/wasm-debugger-experiments/README.md`. Its publication is coordinated separately; this link is a repository access entry, not a claim that the guide is on its default branch. Authorized developers obtain the matching runtime, Concord, BrowserDebugHost/proxy and app source revisions and build instructions there. Private implementation code is not included here.

## Build and prerequisites

Clone the dedicated carry-forward branch and select the exact full commit recorded for this revision by the canonical guide. No local carry-forward patch is needed for that committed source. For any later unpublished experiment change, record the committed base plus the actual approved diff and SHA-256 separately. This branch preserves the earlier prototype ancestry, including `31d0dfdc149c205b54c6f76c52beb52e6cd670c8`, which is historical provenance rather than the reproduction pin.

```sh
git clone --branch steveisok-wasm-debugger-carry-forward https://github.com/steveisok/vscode-csharp.git
cd vscode-csharp
# Use the full carry-forward SHA from the matching canonical manifest:
git switch --detach <manifest-vscode-csharp-full-commit-sha>
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
```

```sh
npm ci --ignore-scripts
npm run packageDev
```

Restore fresh local language-server components (`.roslyn`, `.roslynDevKit`, `.xamlTools`, `.testDiscovery`) with the repository's `npm run installDependencies` after the explicit `npm ci --ignore-scripts`. Run restore with process-local `DOTNET_GENERATE_ASPNET_CERTIFICATE=false` and `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false`; use an isolated `DOTNET_CLI_HOME` and caches as needed, and record the actual selected SDK. These .NET safeguards matter on first use; `DOTNET_SKIP_FIRST_TIME_EXPERIENCE` alone did not prevent a development-certificate notice in the fresh experiment. Do not modify global SDK/tool/configuration state. The launcher does not restore dependencies. **Do not run release VSIX packaging** for prototype staging: it deletes local component folders and restores the stock debugger.

Required host tools: Node 22+ (the accepted measurements used Node 24.15.0), an installed native VS Code executable, Edge or Chrome, the matching .NET/ASP.NET Core runtime for BrowserDebugHost, and `dotnet-serve` for the existing Small sample. The accepted host used .NET 10.0.301 SDK / 10.0.9 runtime; Havit's interpreted build used `12.0.100-alpha.1.26509.106`. These are provenance, not permission to combine incompatible packs. Browser versions, future build versions and exact source/asset hashes belong in the canonical manifest. Preflight checks file/config/cohort contracts, not whether a native loader actually runs.

Supply a local VS Code dependency-extension directory (for example the existing .NET runtime acquisition extension); VS Code supplies its JS debugger or a compatible local JS-debug extension can be supplied there. No downloads, global extension replacement or global VS Code settings edits occur in this launcher. The isolated profile records the configured `dotnet` for C# runtime acquisition, and the prototype proxy host bypasses acquisition using the same explicit native executable.

If missing, provision `dotnet-serve` with `dotnet tool install dotnet-serve --tool-path <dedicated-local-tools>` and use the explicit resulting executable. Install dependency extensions with the VS Code CLI's explicit `--user-data-dir <private-install-profile>` and `--extensions-dir <dedicated-dependencies>` options, never the user profile/extension directory. Use a recorded local feed configuration for an authorized environmental mirror follow-up if a restore fails; preserve the first failure and label the deviation instead of claiming the recipe worked as written. Record actual VS Code/browser versions, native executable paths and both .NET/ASP.NET Core shared frameworks; historical versions are not inferred from artifact hashes.

## Machine-local configuration versus portable provenance

Copy `localConfig.example.json` to `machine.local.json` in this directory and edit it. `*.local.json`, binaries, staging, profiles and run artifacts are ignored; **never commit machine paths, credentials, component packages or raw logs**.

The example contains role placeholders, not working artifact locations. Relative paths resolve from the config file's directory. `${configDir}`, `${home}`, `${extensionRoot}`, `${artifactRoot}` and earlier named `paths` fields (such as `${runtimeRoot}` and `${havitRoot}`) are supported; unknown tokens fail. Native paths with spaces are passed as individual `spawn`/`execFile` arguments, not shell commands. Use JSON-escaped native Windows paths on Windows.

`extensionRoot` is the isolated prototype checkout. `artifactRoot` must be inside that checkout's `out`; choose an experiment-specific empty area rather than historic captures. `profileRoot` is a short private scratch area, never a real user VS Code profile. The example `${home}/p/csharp-prototype` requires an existing explicitly created private parent; even that path may need shortening on a long home path. Only new `r-<12 UUID hex>` profile directories are used, without global symlinks. `private-profile.json` records ownership; after cleanup, verified **logs only** are copied into the result so evidence no longer depends on that separate profile.

`executables.vscode` and `executables.browser` may be omitted to probe a small set of host-specific known native installations. An explicit missing path always fails instead of selecting another installation. `dotnet` and `dotnetServe` require explicit file paths. Discovery does not install anything. Specify `browserType` matching the executable (`edge` or `chrome`).

The typed schema/validation is in [`prototypeConfig.ts`](prototypeConfig.ts). The machine config supplies:

| Field | Purpose |
|---|---|
| `manifest` | Complete artifact-cohort manifest supplied by the canonical owner |
| `paths.runtimeRoot`, `paths.havitRoot` | Local sources matching the PDB source checksums |
| `paths.runtimePack` | Whole matching interpreted browser runtime pack |
| `paths.concordPublish`, `paths.proxyPublish` | Whole native host / BrowserDebugHost publish directories; Concord runs directly from its verified producer package |
| `paths.nativeAssets` | Matching host universal DAC/DBI and supplied companions |
| `paths.smallWebRoot`, `paths.havitWebRoot` | Whole published app webroots, never WASM-only overlays |
| `paths.smallHandoff`, `paths.havitHandoff` | Frozen owner readiness/source/PDB handoffs |
| `paths.havitServerModule` | Existing app `bench.mjs`; adapter imports **only** `startServer` |
| `paths.extensionDependencies` | Existing local VS Code dependency extensions |
| `sourceMaps.small`, `sourceMaps.havit` | PDB build roots mapped to the verified local source roots |
| `ports` | Distinct loopback Small/Havit/DAP/Electron-CDP ports |
| `allowUnvalidatedHost` | Explicit experimental opt-in; never grants missing-host artifacts or claims acceptance |
| `browserProfile` | Optional, default off. One dedicated browser user-data directory reused by every run (e.g. when policy forces browser sign-in). Recorded as a deviation; a warm cache becomes possible |
| `extendedInspection` | Optional, default off. **Workflow mode** following `debugger-performance-comparison.md`: launch -> first `Debugger.Break`; automatic top-frame Locals and call stack; caller frame, caller Locals and caller `this` through the Call Stack/Variables UI (real mouse input; N/A for Small's static `Main`); Continue -> second `Debugger.Break` (`extendedInspection.secondBreak` in the workload); the same inspection there; then one Step Over. It does **not** run the F10 15->N steps; use F10 mode (no opt-ins) for those. Use a separate `artifactRoot`, because capability sidecars bind artifact hashes, not opt-ins |
| `diagnosticLogging` | Optional, default off. Sets `WASMDBG_PERFORMANCE_LOGGING=1` (removes `WASMDBG_LOGGING`) for the proxy and Concord `logging.elapsedTiming`; with `extendedInspection`, adds an unscored closing action. Diagnostic only, not a timing reference |
| `havitClosingAction` | Optional (`stepOver` or `continue`, default `continue`): Havit closing action when both `diagnosticLogging` and `extendedInspection` are set |

### Artifact-cohort manifest contract (schema version 1)

This is an asset contract; the canonical private guide separately owns repository origins, exact source revisions and build instructions. Historical patch digests are not substitutes for published reproduction commits. The guide does not promise byte-deterministic builds or downloadable historic binaries.

- `cohortId`: nonempty cohort label; `targetArchitecture`: exactly `wasm32`, separate from host architecture; `versions`: recorded string-valued tool/build versions.
- `hosts["darwin-arm64"|"darwin-x64"|"linux-x64"|"linux-arm64"|"win32-x64"|"win32-arm64"]`: only hosts with supplied artifacts. Each has `concord`, `proxy`, `native`, `endToEndValidated` and `features.wasmdbgArtifactDir`.
- Each artifact group is `{cohortId, files:[{path,size,sha256}]}`. Paths are safe relative paths; all file sizes/hashes and the complete directory file set are checked (a local `install.Lock` is exempt). Mixing old files into a new publish fails.
- `runtimePack`: the same complete asset group. `workloads.small` / `workloads.havit` each extend an asset group for the complete webroot with `assembly`, relative `appDll`, `appPdb`, `nativeWasm`, `handoffSha256` and `sourceFiles:[{path,sha256}]` relative to the corresponding source root. The app's target WASM hash must occur in the runtime pack. App source and handoff hashes must match, and `explicitRunnableHandoff` must be true without an owner hold.
- Result-producing `run` commands also require `sources:[{id,origin,ref,commit,localPatch?:{path,sha256}}]`. For a clean published build, `commit` is its immutable revision and `localPatch` is omitted. Only an actual local, uncommitted/unpublished source change requires the committed base plus its exact diff file and SHA-256; do not stamp a dirty build with the published commit alone. Preflight validates supplied provenance and optional patch bytes; each batch and run bundles the complete cohort inventory, configuration, owner handoffs, source identities and any actual local patches. No credentials belong in these files.
- The host architecture/cohort is checked against native filenames; a missing host entry fails with a portability blocker instead of falling back to macOS. Signed/hash provenance does not replace a real Windows/Linux capability pilot.

| Host | Native DAP / Concord engine | Universal DBI / DAC |
|---|---|---|
| macOS | `vsdbg-ui` / `libvsdebugeng.impl.dylib` | `libmscordbi_universal.dylib` / `libmscordaccore_universal.dylib` |
| Linux | `vsdbg-ui` / `libvsdebugeng.impl.so` | `libmscordbi_universal.so` / `libmscordaccore_universal.so` |
| Windows | `vsdbg-ui.exe` / `vsdebugeng.impl.dll` | `mscordbi_universal.dll` / `mscordaccore_universal.dll` |

`amd64`/`x86_64` host aliases normalize to `x64`. These names are required inputs for an intended host; they do not assert that an available Unix prototype has already been ported. Unsupported OS/architecture combinations fail before staging.

## Commands (no Copilot required)

```sh
npm run prototype -- preflight --config tasks/debugger/prototype/machine.local.json
npm run prototype -- setup --config tasks/debugger/prototype/machine.local.json
npm run prototype -- open small --config tasks/debugger/prototype/machine.local.json
npm run prototype -- open havit --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run small 1 capability --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run havit 1 capability --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run small 3 steps --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run havit 3 steps --config tasks/debugger/prototype/machine.local.json
```

The common entry is [`prototype.js`](prototype.js); Bash is not required. `preflight` launches no process. `setup` creates a new ignored stage and launches no process. `open`/`run` deliberately stage a new generation rather than select an ambiguous “latest” directory or modify existing archives. The extension bundle, language components, proxy and workloads use physical copies, not symlinks. **Concord is not copied into each stage:** both launch commands verify the complete `paths.concordPublish` file set/hashes again immediately before starting its native executable. Keep that producer package immutable for the cohort; a changed companion file fails launch. `runtimeDependencies=[]` excludes stock downloads. No fake native installation markers are created.

The launcher passes that existing configured package path through a process-scoped prototype environment variable. Only the opted-in browser adapter uses its explicit loopback `debugServer`; ordinary debugger sessions retain their normal package-install checks. Missing explicit package files/ports fail rather than trigger a download or select another debugger. No global setting, symlink, changed working-directory assumption or shortened-path workaround is used.

`open` owns the local app server, Concord DAP listener and private VS Code window. Select the staged debug configuration and F5. Closing the private window or interrupting the launcher cleans up owned helpers. POSIX helpers run in dedicated owned process groups; Windows uses `taskkill /PID <owned PID> /T` with escalation, never name-based killing. Occupied ports fail closed and other users' processes are untouched. There is no graceful-native-shutdown reliability claim.

`run` uses the same existing integration test and automatic UI inspection helpers, not a new benchmark harness. It accepts `<small|havit> <1..5> <steps|entry|capability>`; entry/capability require exactly one repetition. Reports, IDs, raw captures and failure handling are shared with `debuggerReports.ts`. After owned helpers stop, the runner copies **only the private profile's logs**, not its cache or entire profile, into `vscode-logs/` and verifies their complete file set/hashes. Reports link to that bundled directory relatively. `private-profile.json` records launch ownership, not a required external evidence dependency. Missing diagnostics are explicit in `log-retention.json`; copy/cleanup failure cannot produce a passed result. Proxy, native, test-console logs and raw UI evidence remain in the run, including on capability failure.

```text
artifactRoot/
  stage-<host>-<UUID>/                 # generated local extension/workspaces/config
  <workload>-<mode>-batch-<UTC>-<12UUIDhex>/
    README.md, report-metadata.json, cohort-provenance.json, measurement-summary.json
    provenance/                       # complete cohort/config/source pins and local patches
    <workload>-<mode>-run-<UTC>-<12UUIDhex>/
      README.md, report-metadata.json, raw JSON/logs/screenshots
      provenance/                     # self-contained identities/config/patches/handoffs
      private-profile.json            # launch ownership; profile cache is not bundled
      vscode-logs/, log-retention.json # verified private diagnostic logs and explicit absence/failure
      proxy-logs/                     # created by the feature-gated proxy
  report-registry/, README.md
```

Result bundles contain evidence and byte inventories, not debugger executables, SDKs or runtime packs. Preserve one immutable producer package per cohort separately. Diagnostic files/absence are reported as observed: the existing capture does not establish full CDP wire/session plus frontend DAP exactly-once readiness pairing merely from a successful DOM result. Browser tracing, JMC, evaluation policy and failure bounds are unchanged by package placement or log retention.

After each repetition, `post-cleanup-verification.json` records exact owned PID/process-group exit and the availability of configured ports plus dynamic listeners discovered in the retained proxy/browser logs. An occupied port or surviving owned process fails the run instead of permitting another repetition. Keep the native wrapper's SIGTERM/SIGKILL outcome distinct from graceful native unload.

### Disk space and stage retention

The runner stages once per invocation, not once per repetition, but a fresh physical extension/components/webroot stage can still consume about 2 GiB on the observed host. Check actual free space and estimated stage/log/profile needs **before each invocation**. Use the existing 3.7 GiB stage-plus-reserve safety check as an operator budget for this observed layout, not a portable size guarantee. Avoid a redundant `setup` before `run`, and never duplicate entire profile caches or giant binary archives just to preserve results.

Stage pruning is **manual, not automatic runner behavior**. After confirmed owned helper exit, an explicitly approved redundant stage may be released only after preserving its complete file SHA-256/size/mode inventory, symlink targets and producer identity, stage manifest, workload JSON, launch/workspace/project configurations and all unique files inside the canonical result batch. Verify every remaining payload byte is still available in an immutable producer or a retained input; do not remove sole-source bytes. Use one inspected, resolved stage path at a time, never broad root deletion or wildcards. Results/raw logs/screenshots/source patches/configuration, producer packages, other experiments and user primary checkouts are not stage-cleanup targets.

## Readiness, normal stepping and measurement boundaries

Keep normal handshake, JMC and default implicit-evaluation policy. Small uses its actual Main user break and normal F10 15->16->17. Havit uses the opt-in **fully interpreted/no-R2R URL-helper primitive** scenario, not ordinary benchmark parity or the deferred async grid-filtering workload. Start `/components/HxGrid` without a fragment. After attach, app-module/configurationDone and first render, click the existing desktop “Filtering from headers” anchor once, Back, then Forward through that real history entry. Same-page fragment clicks alone skip .NET `LocationChanged`; ordinary history notification reaches the helper. Preparation 15->16->18 is untimed; measure only real F10 18->19->20. Do not step out of line 20.

Both staged workloads use baseline browser `trace: true` for matched capture settings. Havit needs the owned-browser DevTools announcement for its existing history-navigation helper; both workloads retain the browser/js-debug trace for correlation. This is not an escalation of proxy protocol logging, native diagnostics or evaluation. Record the cohort logging difference from earlier trace-omitted capability runs; those sidecars do not authorize or constitute a matched timing comparison. Trace/capture overhead remains included, and exact readiness wire pairing requires an offline audit of actual recorded tuples.

The configured origin/port determines the expected real `url` and `hashIndex`, rather than a fabricated hardcoded scalar. Frozen source/PDB/owner handoffs and actual stop/Locals/UI observations are still required. A source manifest or schedule acknowledgement is not a real managed stop. A first capability pilot must pass before a repeated headline batch. Readiness response failures remain loud at 10s; automatic inspection is bounded at 30s with 300ms quiet and 25ms polling. Visible refresh includes quiescence/poll/capture overhead. No duplicate explicit inspection, Watch or expansion is added. Absence of completion markers is not proof that no implicit evaluation happened.

The maintained runner requires a passed individual capability report in the same artifact area for the **same selected workload, host and exact hashed cohort, including the source manifest** before `steps` mode. The producer handoff establishes artifact readiness, not debugger acceptance: no stale `debuggerCapabilitiesVerified` owner boolean is required or sufficient. Actual observed capability reports authorize repeated runs; missing, failed or mismatched reports fail before any helper starts. Explicit owner launch/measurement holds still apply. Changing any app/PDB/native/proxy/source-manifest hash requires its own capability pilot.

Report n/min/median/max; no p95 from six points. App statement CPU remains included, request sums overlap, transport reads include waiting. Do not compare independent OS cohorts in lockstep or infer a regression/root cause from unvalidated cross-host observations.

For the bounded matched shape, use one manifest/capture/tool cohort, pass `small 1 capability` and `havit 1 capability` in the same artifact area, then run **three fresh sessions/two legal steps per session** for each workload sequentially. A changed manifest or build requires new capability sidecars. Do not mix trace-omitted capabilities, different source manifests or failed sessions into an accepted six-step distribution.

Future summaries finalize acceptance **after** unchanged owned cleanup and diagnostic retention: `samples` and `completedRuns/completedSteps` include only passed runs; `observedSamples` retain the runner's loaded step observations; `excludedSamples/excludedRunIds` keep failed/incomplete observations. Per-run raw captures remain authoritative on an early test failure before batch observations could be loaded. `acceptedDistributions` may describe explicitly labeled partial accepted runs, but `distributions` is empty for a failed/incomplete batch and no timing distribution is manufactured for entry/capability mode. Preserved earlier summaries are not rewritten by this accounting correction.

If cleanup or log retention fails after successful UI steps, keep the run and batch failed and preserve the raw steps/lifecycle/error. `EPERM` cleanup investigation is deferred, not suppressed or treated as graceful success. Any later independent exit verification/log recovery is supplemental evidence, not automatic acceptance promotion. A replacement session requires explicit authorization, a new exclusive run and separate labeling; count only passed sessions and disclose every attempt and excluded diagnostic sample. No retry-until-fast behavior is allowed.

Audit recorded frontend evaluate requests offline using the retained js-debug trace: bind each DAP connection/request sequence to one CDP connection/session/wire request and reply, one frontend DAP reply, and the actual correct value within 10 seconds. Existing bounded Havit captures provide finite tuple evidence; Small has no DOM readiness evaluate loop, so do not invent unexercised IDs. The independent navigation helper's transport is excluded when its wire tuples are not recorded. Audits and setup do not enter the headline F10 samples.

## Portable proxy logs: new source only

The private proxy owner's option is `WASMDBG_ARTIFACT_DIR`, an absolute native-host directory, selected once per host process. The launcher passes a dedicated fresh `run/proxy-logs` via `VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR`; only the extension's proxy child translates it to the actual option. Existing `WASMDBG_LOGGING` / `WASMDBG_PERFORMANCE_LOGGING` enable flags are unchanged; the path option does not enable logging. The proxy creates the directory and rejects reused log names, relative/foreign paths and write failures, with no silent fallback.

**The historically accepted proxy `250aea...` / host `41855...` does not implement that option.** Its historical `C:\diag` literal log names remain untouched. A portable run requires the guide's portable-log source revision, a **new complete host/proxy publish**, new exact hashes and `features.wasmdbgArtifactDir=true`. The published base phase did not measure that new combination; later fresh local experiments used new actual bytes and separate retained cohorts. Preflight still rejects an old/unknown feature rather than relabeling historical binaries.

## Remaining reproducibility gaps

The canonical guide and private component sources require internal access; their publication is coordinated independently of this public extension branch. Durable download/retention of historic binary cohorts and raw 2GB archives is not established; obtain/build matching component inputs explicitly rather than assume a remote artifact service. Windows/Linux native portability, process behavior, Electron UI capture, browser setup, dependency packaging and actual source stepping need their own owned pilot before any acceptance/performance claim. Configuration tests do not close those gaps.

Historical manifests/raw archives and source pins remain immutable. The earlier fresh experiments built the extension base with local patches; their frozen diffs, compatibility and measured cohorts remain the accurate artifact-build provenance even after the carry-forward source is committed. Pin the new carry-forward source revision for future builds, without rewriting old evidence as if it used that commit. No compatibility-only result is a performance measurement, and prior patched-native timings are not relabeled as unmodified-native timings.
