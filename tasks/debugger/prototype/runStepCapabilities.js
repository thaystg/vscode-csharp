/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const toolRoot = path.resolve(__dirname, '../../..');
const { parseDebuggerWorkload, assertRunnableWorkload } = require(
    path.join(toolRoot, 'out/test/lsptoolshost/integrationTests/debuggerWorkload.js')
);
const {
    allocateReportDirectory,
    writeReport,
    evidenceLinks,
    relativeReportLink,
    timingDistributions,
    hasMatchingCapability,
    bundlePrivateProfileLogs,
    summarizeObservedRuns,
} = require(path.join(toolRoot, 'out/test/lsptoolshost/integrationTests/debuggerReports.js'));
const { OwnedProcesses } = require(path.join(toolRoot, 'out/tasks/debugger/prototype/ownedProcesses.js'));
const { verifiedConcordExecutable } = require(path.join(toolRoot, 'out/tasks/debugger/prototype/prototypeConfig.js'));
const { bundlePrototypeProvenance } = require(path.join(toolRoot, 'out/tasks/debugger/prototype/prototypeEvidence.js'));

async function freePort(port) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => listener.close(resolve));
    });
}
async function verifyCleanup(run, machine, children) {
    const receipt = { verifiedAt: new Date().toISOString(), processes: [], ports: [], failures: [] };
    for (const child of children) {
        if (!child.pid) continue;
        for (const pid of process.platform === 'win32' ? [child.pid] : [child.pid, -child.pid]) {
            try {
                process.kill(pid, 0);
                receipt.processes.push({ pid, exists: true });
                receipt.failures.push(`Owned process/group ${pid} still exists.`);
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
                receipt.processes.push({ pid, exists: false });
            }
        }
    }
    const ports = new Set(Object.values(machine.ports));
    function inspectLogs(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) inspectLogs(file);
            else if (entry.name.endsWith('VsWebAssemblyBridge.log')) {
                const text = fs.readFileSync(file, 'utf8');
                for (const match of text.matchAll(
                    /(?:Listening iCorDebug on: |Waiting for browser on: |Now listening on: http:\/\/127\.0\.0\.1:)(\d+)/g
                )) {
                    ports.add(Number(match[1]));
                }
            }
        }
    }
    const logs = path.join(run, 'vscode-logs');
    if (fs.existsSync(logs)) inspectLogs(logs);
    const attach = path.join(run, 'managed-attach-result.json');
    if (fs.existsSync(attach)) {
        for (const event of JSON.parse(fs.readFileSync(attach)).browserMessages) {
            const match = String(event.message.body?.output).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (match) ports.add(Number(match[1]));
        }
    }
    for (const port of ports) {
        try {
            await freePort(port);
            receipt.ports.push({ port, available: true });
        } catch (error) {
            receipt.ports.push({ port, available: false, error: String(error) });
            receipt.failures.push(`Owned listener port ${port} is unavailable after cleanup.`);
        }
    }
    fs.writeFileSync(path.join(run, 'post-cleanup-verification.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    if (receipt.failures.length) throw Error(receipt.failures.join(' '));
}
function browserProfileRecord(machine) {
    const record = machine.browserProfile
        ? {
              mode: 'shared-user-authorized',
              path: machine.browserProfile,
              deviation:
                  'User-authorized deviation from the fresh-profile-per-run rule: a dedicated signed-in browser profile is reused because policy forces browser sign-in. Only logs, not profile data, are retained.',
          }
        : { mode: 'fresh-per-run' };
    return machine.diagnosticLogging
        ? { ...record, diagnosticLogging: 'DIAGNOSTIC run: proxy performance logging, Concord elapsedTiming, closing action; not a timing reference' }
        : record;
}
async function waitReady(check, child, label) {
    const deadline = Date.now() + 20000;
    let last;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw Error(`${label} exited before readiness: ${child.exitCode}`);
        try {
            await check();
            return;
        } catch (error) {
            last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`${label} not ready: ${last}`);
}
async function runStepCapabilities(options) {
    const { config: machine, host, manifest, stage, createPrivateProfile, childEnvironment } = options;
    const root = machine.extensionRoot;
    const artifactRoot = machine.artifactRoot;
    const selector = options.selector;
    if (!['small', 'havit'].includes(selector)) throw Error('Select small or havit.');
    const repetitions = options.repetitions;
    const mode = options.mode;
    if (!['steps', 'entry', 'capability'].includes(mode) || (mode !== 'steps' && repetitions !== 1)) {
        throw Error('Use steps or one bounded entry/capability pilot.');
    }
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
        throw Error('Use one to five bounded runs.');
    const config = JSON.parse(fs.readFileSync(path.join(stage, 'workloads', `${selector}.json`), 'utf8'));
    const handoff = JSON.parse(fs.readFileSync(path.join(stage, config.handoff), 'utf8'));
    assertRunnableWorkload(handoff);
    if (handoff.nextPilotHeld === true) {
        throw Error(`Workload pilot is held: ${handoff.pilotHoldReason}`);
    }
    if (mode === 'steps' && handoff.measurementReady === false) {
        throw Error('Headline measurements are held pending the new proxy untimed readiness gate.');
    }
    if (handoff.nextPilotHeldUntilVerifiedDacChange === true) {
        throw Error(`Workload pilot is held pending a verified DAC correction: ${handoff.currentManagedBlocker}`);
    }
    const workload = parseDebuggerWorkload(config);
    if (config.diagnosticOnly === true && mode === 'steps') {
        throw Error('Temporary diagnostic workload cannot produce headline measurements.');
    }
    if (!workload.server) throw Error('Explicit owned server command required.');
    const framework = path.join(stage, workload.workspace, 'wwwroot/_framework');
    const nativeWasm = fs
        .readdirSync(framework)
        .filter((file) => file.startsWith('dotnet.native') && file.endsWith('.wasm'));
    if (!nativeWasm.length) throw Error('Complete staged native WASM is required.');
    const cohort = Object.fromEntries(
        [
            ['extensionBundle', path.join(stage, 'extension/dist/extension.js')],
            ['concord', path.join(machine.paths.concordPublish, host.concordEngine)],
            [
                'browserDebugHost',
                path.join(stage, 'extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugHost.dll'),
            ],
            [
                'browserDebugProxy',
                path.join(stage, 'extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugProxy.dll'),
            ],
            [
                'browserDebugHostRuntimeConfig',
                path.join(
                    stage,
                    'extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugHost.runtimeconfig.json'
                ),
            ],
            ['dbi', path.join(framework, host.dbi)],
            ['dac', path.join(framework, host.dac)],
            ['appAssembly', path.join(framework, workload.assembly + '.dll')],
            ['appPdb', path.join(framework, workload.assembly + '.pdb')],
        ].map(([name, file]) => [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
    );
    cohort.sourceManifest = crypto.createHash('sha256').update(fs.readFileSync(machine.manifest)).digest('hex');
    cohort.nativeWasmFiles = Object.fromEntries(
        nativeWasm.map((file) => [
            file,
            crypto
                .createHash('sha256')
                .update(fs.readFileSync(path.join(framework, file)))
                .digest('hex'),
        ])
    );
    if (mode === 'steps' && !hasMatchingCapability(artifactRoot, selector, cohort, host.key)) {
        throw Error(
            `Run ${selector} 1 capability first in this artifact area for the exact ${host.key} cohort; source/preflight/old host acceptance is not a current pilot.`
        );
    }
    const identity = allocateReportDirectory(artifactRoot, selector, mode);
    const batch = path.join(artifactRoot, identity.directory);
    const command = ['prototype', 'run', selector, String(repetitions), mode, '--config', options.configFile];
    bundlePrototypeProvenance(batch, options.configFile, machine, manifest, host, command);
    const versions = Object.fromEntries(
        Object.entries({
            node: process.version,
            ...manifest.versions,
            host: host.key,
            platformAcceptance: host.validation,
            sdk: config.sdk,
            compiler: config.compiler,
            profile: config.profile,
        }).filter(([, value]) => typeof value === 'string')
    );
    const batchReport = {
        ...identity,
        workload: selector,
        scenario: config.scenario ?? 'existing-main-user-break',
        mode,
        status: 'incomplete',
        startedAt: identity.generatedAt,
        finishedAt: null,
        cohort,
        versions,
        requestedRuns: repetitions,
        completedRuns: 0,
        completedSteps: 0,
        links: [],
    };
    writeReport(artifactRoot, batchReport, []);
    fs.writeFileSync(
        path.join(batch, 'cohort-provenance.json'),
        JSON.stringify(
            {
                batchId: identity.batchId,
                workload,
                host,
                sourceManifest: machine.manifest,
                cohortId: manifest.cohortId,
                handoff,
                cohort,
                createdAt: new Date().toISOString(),
                singleNativeSwapForbidden: true,
                knownNativeCloseLimitationsNotSuppressed: true,
                browserProfile: browserProfileRecord(machine),
            },
            null,
            2
        )
    );
    const workspace = path.join(stage, workload.workspace);
    const all = [];
    let suiteFailed = false;
    let completedRuns = 0;
    const runReports = [];
    try {
        for (let index = 0; index < repetitions; index++) {
            const runIdentity = allocateReportDirectory(artifactRoot, selector, mode, identity);
            const run = path.join(artifactRoot, runIdentity.directory);
            bundlePrototypeProvenance(run, options.configFile, machine, manifest, host, command);
            const runReport = {
                ...runIdentity,
                workload: selector,
                scenario: batchReport.scenario,
                mode,
                status: 'incomplete',
                label: `Run ${index + 1}`,
                startedAt: runIdentity.generatedAt,
                finishedAt: null,
                cohort,
                versions,
                links: [],
                completedSteps: 0,
            };
            runReports.push(runReport);
            writeReport(artifactRoot, runReport, []);
            fs.writeFileSync(
                path.join(run, 'cohort-provenance.json'),
                JSON.stringify(
                    {
                        batchId: identity.batchId,
                        runId: runIdentity.runId,
                        workload,
                        cohort,
                        versions,
                        startedAt: runIdentity.generatedAt,
                        browserProfile: browserProfileRecord(machine),
                    },
                    null,
                    2
                )
            );
            const owned = new OwnedProcesses();
            const helpers = owned.children;
            let runSamples = [];
            let profile;
            const env = childEnvironment(machine, run);
            const start = (command, args, log) => {
                const fd = fs.openSync(path.join(run, log), 'w');
                const child = owned.spawn(command, args, { cwd: run, env, stdio: ['ignore', fd, fd] });
                child.ownedLogFile = log;
                fs.closeSync(fd);
                return child;
            };
            try {
                for (const port of [Number(new URL(workload.url).port), machine.ports.dap, machine.ports.ui])
                    await freePort(port);
                profile = createPrivateProfile(machine, host);
                fs.writeFileSync(
                    path.join(run, 'private-profile.json'),
                    JSON.stringify(
                        {
                            profile,
                            owned: true,
                            explanation:
                                'Separate short private native profile; logs are copied into this result after owned cleanup, not the profile/cache.',
                        },
                        null,
                        2
                    )
                );
                const server = start(
                    workload.server.command,
                    workload.server.args.map((arg) => arg.replaceAll('${workspace}', workspace)),
                    'server.log'
                );
                await waitReady(
                    async () => {
                        const response = await fetch(workload.url, { signal: AbortSignal.timeout(1000) });
                        if (!response.ok) throw Error(`HTTP ${response.status}`);
                    },
                    server,
                    'App server'
                );
                const dap = start(
                    verifiedConcordExecutable(machine, host, manifest),
                    [`--server=${machine.ports.dap}`, '--consoleLogging'],
                    'native-console.log'
                );
                await waitReady(
                    async () => {
                        if (
                            !fs
                                .readFileSync(path.join(run, 'native-console.log'), 'utf8')
                                .includes('Waiting for communication')
                        ) {
                            throw Error('DAP listener not ready.');
                        }
                    },
                    dap,
                    'DAP listener'
                );
                const testEnv = {
                    ...env,
                    CODE_EXTENSIONS_PATH: root,
                    TEST_FILE_FILTER: path.join(
                        root,
                        'test/lsptoolshost/integrationTests/browserCoreClr.integration.test.ts'
                    ),
                    WASM_PROTOTYPE_DIRECTORY: stage,
                    WASM_PROTOTYPE_RUN_DIRECTORY: run,
                    WASM_PROTOTYPE_BATCH_ID: identity.batchId,
                    WASM_PROTOTYPE_RUN_ID: runIdentity.runId,
                    WASM_PROTOTYPE_WORKLOAD: selector,
                    WASM_PROTOTYPE_STEP_CAPABILITIES: '1',
                    WASM_PROTOTYPE_ENTRY_ONLY: mode === 'entry' ? '1' : '0',
                    WASM_PROTOTYPE_MEASUREMENT_ENABLED: mode === 'steps' ? '1' : '0',
                    // User-directed extended actions: launch/break boundaries and UI caller inspection after the final stop.
                    WASM_PROTOTYPE_EXTENDED_ACTIONS: machine.extendedInspection ? '1' : '0',
                    WASM_PROTOTYPE_DIAGNOSTIC_LOGGING: machine.diagnosticLogging ? '1' : '0',
                    // Diagnostic only: close the final pause so the proxy logs its epoch totals. Havit always uses Continue
                    // (a step after the caller-this func-eval hangs; user decision); Small session 5 of steps is the Continue variant.
                    WASM_PROTOTYPE_CLOSING_ACTION: !(machine.diagnosticLogging && machine.extendedInspection)
                        ? 'none'
                        : selector === 'havit'
                          ? (machine.havitClosingAction ?? 'continue')
                          : mode === 'steps' && index === 4
                            ? 'continue'
                            : 'stepOver',
                    WASM_PROTOTYPE_UI_PORT: String(machine.ports.ui),
                    WASM_PROTOTYPE_NODE: process.execPath,
                    WASM_PROTOTYPE_BROWSER: machine.executables.browser,
                    // Keep the browser profile under a short path; deep run paths exceed Windows MAX_PATH.
                    WASM_PROTOTYPE_BROWSER_PROFILE: machine.browserProfile ?? path.join(profile, 'browser-profile'),
                    WASM_PROTOTYPE_BROWSER_TYPE: machine.browserType,
                };
                const testLaunch = {
                    vscodeExecutablePath: machine.executables.vscode,
                    extensionDevelopmentPath: path.join(stage, 'extension'),
                    extensionTestsPath: path.join(root, 'out/test/lsptoolshost/integrationTests/index.js'),
                    launchArgs: [
                        workspace,
                        '--new-window',
                        '--disable-workspace-trust',
                        '--skip-welcome',
                        '--skip-release-notes',
                        '--disable-extension',
                        'github.copilot-chat',
                        `--remote-debugging-port=${machine.ports.ui}`,
                        '--user-data-dir',
                        profile,
                        '--extensions-dir',
                        path.join(stage, 'extensions'),
                        '--log',
                        'ms-dotnettools.csharp:info',
                    ],
                    extensionTestsEnv: testEnv,
                };
                const testFile = path.join(run, 'test-launch.json');
                fs.writeFileSync(testFile, JSON.stringify(testLaunch, null, 2));
                const tests = start(
                    process.execPath,
                    [path.join(__dirname, 'launchTests.js'), testFile],
                    'test-console.log'
                );
                await new Promise((resolve, reject) => {
                    tests.once('error', reject);
                    tests.once('close', (code, signal) =>
                        code === 0
                            ? resolve()
                            : reject(Error(`Owned integration runner failed: ${code}/${signal}; see test-console.log`))
                    );
                });
                if (mode !== 'entry') {
                    const result = JSON.parse(fs.readFileSync(path.join(run, 'automatic-step-results.json'), 'utf8'));
                    const attach = JSON.parse(fs.readFileSync(path.join(run, 'managed-attach-result.json'), 'utf8'));
                    if (attach.stepCapabilitiesCheckPassed !== true || attach.failure)
                        throw Error('Automatic step capability did not pass.');
                    runSamples = result.steps;
                    // Workflow mode records one Step Over (from the second user break); F10 mode is unchanged.
                    const expectedSteps = machine.extendedInspection
                        ? 1
                        : workload.stops.length - 1 - (workload.preparationTransitions ?? 0);
                    if (runSamples.length !== expectedSteps || result.measurementEnabled !== (mode === 'steps')) {
                        throw Error('Automatic step capture is incomplete or has the wrong measurement mode.');
                    }
                    if (mode === 'steps') timingDistributions(runSamples);
                    all.push(
                        ...runSamples.map((step) => ({
                            batchId: identity.batchId,
                            runId: runIdentity.runId,
                            run: index + 1,
                            ...step,
                        }))
                    );
                } else {
                    const result = JSON.parse(fs.readFileSync(path.join(run, 'managed-attach-result.json'), 'utf8'));
                    if (!result.entryCapabilitiesCheckPassed) throw Error('Managed entry pilot did not pass.');
                }
                runReport.status = 'passed';
                runReport.completedSteps = runSamples.length;
            } catch (error) {
                fs.writeFileSync(path.join(run, 'run-failure.txt'), String(error));
                suiteFailed = true;
                runReport.status = 'failed';
                runReport.failure = String(error);
                batchReport.failure = String(error);
                throw error;
            } finally {
                const beforeCleanup = helpers.map((child) => ({
                    log: child.ownedLogFile,
                    pid: child.pid,
                    exitCode: child.exitCode,
                    signalCode: child.signalCode,
                }));
                let cleanupFailure;
                try {
                    await owned.stop();
                } catch (error) {
                    cleanupFailure = String(error);
                    runReport.status = 'failed';
                    runReport.failure ??= cleanupFailure;
                    batchReport.failure ??= cleanupFailure;
                    suiteFailed = true;
                    console.error('Owned cleanup failed; original run error (if any):', runReport.failure, error);
                } finally {
                    owned.dispose();
                }
                fs.writeFileSync(
                    path.join(run, 'owned-helper-lifecycle.json'),
                    JSON.stringify(
                        {
                            beforeCleanup,
                            afterCleanup: helpers.map((child) => ({
                                log: child.ownedLogFile,
                                pid: child.pid,
                                exitCode: child.exitCode,
                                signalCode: child.signalCode,
                            })),
                            cleanupCompleted: !cleanupFailure,
                            cleanupFailure,
                            nativeUnloadEventNotAssumed: true,
                        },
                        null,
                        2
                    )
                );
                let retentionFailure;
                try {
                    if (cleanupFailure) {
                        throw Error(`Private logs cannot be frozen before confirmed owned cleanup: ${cleanupFailure}`);
                    }
                    const retained = bundlePrivateProfileLogs(run, profile);
                    if (retained.status !== 'copied' && runReport.status === 'passed') {
                        throw Error(`Passed run has incomplete diagnostic retention: ${retained.reason}`);
                    }
                    await verifyCleanup(run, machine, helpers);
                } catch (error) {
                    retentionFailure = String(error);
                    runReport.status = 'failed';
                    runReport.failure ??= retentionFailure;
                    batchReport.failure ??= retentionFailure;
                    suiteFailed = true;
                    fs.writeFileSync(path.join(run, 'log-retention-failure.txt'), retentionFailure);
                    console.error('Diagnostic retention failed; original run error (if any):', runReport.failure, error);
                }
                const observed = summarizeObservedRuns(runReports, all, mode, repetitions);
                completedRuns = observed.completedRuns;
                fs.writeFileSync(
                    path.join(batch, 'measurement-summary.json'),
                    JSON.stringify(
                        {
                            batchId: identity.batchId,
                            runIds: runReports.map((report) => report.runId),
                            ...observed,
                            workload,
                            mode,
                            cohort,
                            repetitionsRequested: repetitions,
                            supportedScenarioPassed: observed.status === 'passed',
                            definitions: {
                                automaticUiOnly: !machine.extendedInspection,
                                explicitStackScopesVariablesRequests: 0,
                                ...(machine.extendedInspection
                                    ? {
                                          extendedInspectionDeparture:
                                              'USER-DIRECTED workflow mode (debugger-performance-comparison.md), not F10 mode: launch -> first Debugger.Break; automatic top-frame Locals/call stack; UI-driven caller frame, caller Locals and caller this (real mouse input; VS Code issues the scopes/variables requests); Continue -> second Debugger.Break; the same inspection there; then one Step Over. No F10 15->N steps run in this mode; the single step sample is the Step Over from the second break.',
                                      }
                                    : {}),
                                headlineMeasurementEnabled:
                                    mode === 'steps' && observed.status === 'passed',
                                sampleAcceptance:
                                    'Passed run status after owned cleanup and diagnostic retention; failed-run observed samples are excluded.',
                                measurementRequested: mode === 'steps',
                                warmBrowserCache: machine.browserProfile
                                    ? 'possible: shared user-authorized browser profile reused across runs'
                                    : false,
                                panes: 'Call Stack + Variables/Locals, expanded',
                                applicationCpuNotSubtracted: true,
                                startupOrRenderOrAsyncDelayMeasured: false,
                                renderedTime:
                                    'First DOM observation of correct visible source/locals; includes polling/quiescence/capture overhead, not pure paint latency.',
                                observationPollingMs: 25,
                                preCaptureQuiescenceMs: 300,
                                inspectionTimeoutMs: 30000,
                                untimedEntryDomResponseBoundMs: 10000,
                                explicitManagedEvaluationOrObjectExpansionRequested: machine.extendedInspection
                                    ? 'UI-driven caller this expansion after the final stop (user-directed); no explicit evaluation'
                                    : false,
                                automaticUiImplicitEvaluationExcluded: false,
                                implicitEvaluationPolicy:
                                    'Default UI formatting settings preserved; observe and report any automatic function evaluation separately.',
                                adapterLogging: machine.diagnosticLogging
                                    ? `DIAGNOSTIC: protocolMessages=true + logging.elapsedTiming=true; proxy WASMDBG_PERFORMANCE_LOGGING=1 (WASMDBG_LOGGING unset); closing unscored action after the final stop: Small F10 (session 5 of steps: Continue), Havit ${machine.havitClosingAction ?? 'continue'}. Not a timing reference.`
                                    : 'protocolMessages=true, other native diagnostics disabled',
                                browser: `${machine.browserType} headless=new, ${machine.browserProfile ? `DEVIATION: shared user-authorized signed-in profile ${machine.browserProfile} reused across runs` : 'new profile per run'}, default js-debug network cache disabled`,
                                requestedBrowserWindowSize: '1280x900, actual viewport recorded in entry observation',
                                requestSumsOverlap: true,
                                percentilePolicy: 'No p95 claim for this small bounded sample.',
                            },
                        },
                        null,
                        2
                    )
                );
                runReport.finishedAt = new Date().toISOString();
                const attachResultFile = path.join(run, 'managed-attach-result.json');
                if (fs.existsSync(attachResultFile)) {
                    const attach = JSON.parse(fs.readFileSync(attachResultFile, 'utf8'));
                    runReport.observations = {
                        guardedUserBreakObserved: attach.userBreakObserved,
                        ordinaryHistoryNavigationObserved: attach.historyNavigationObserved,
                        actualStoppedSourceLines: attach.messages
                            .filter((e) => e.message.type === 'event' && e.message.event === 'stopped')
                            .map((e) => e.message.body.line),
                        explicitInspectionRequests: attach.explicitInspectionRequests,
                    };
                }
                runReport.links = [
                    { label: 'Batch README', path: relativeReportLink(run, path.join(batch, 'README.md')) },
                    ...evidenceLinks(run),
                ];
                batchReport.status = suiteFailed ? 'failed' : completedRuns === repetitions ? 'passed' : 'incomplete';
                batchReport.completedRuns = completedRuns;
                batchReport.completedSteps = observed.completedSteps;
                batchReport.finishedAt = batchReport.status === 'incomplete' ? null : runReport.finishedAt;
                batchReport.links = [
                    ...runReports.map((report) => ({
                        label: `${report.label}: ${report.runId} (${report.status})`,
                        path: relativeReportLink(batch, path.join(artifactRoot, report.directory, 'README.md')),
                    })),
                    ...evidenceLinks(batch),
                ];
                try {
                    writeReport(artifactRoot, runReport, runSamples);
                    writeReport(artifactRoot, batchReport, observed.samples);
                } catch (reportError) {
                    console.error(
                        'Report generation failed; original run error (if any):',
                        runReport.failure,
                        reportError
                    );
                    if (!suiteFailed) throw reportError;
                }
                if (cleanupFailure || retentionFailure) throw Error(cleanupFailure || retentionFailure);
            }
        }
    } catch (error) {
        batchReport.status = 'failed';
        batchReport.failure ??= String(error);
        batchReport.finishedAt = new Date().toISOString();
        batchReport.links = [
            ...runReports.map((report) => ({
                label: `${report.label}: ${report.runId} (${report.status})`,
                path: relativeReportLink(batch, path.join(artifactRoot, report.directory, 'README.md')),
            })),
            ...evidenceLinks(batch),
        ];
        try {
            writeReport(artifactRoot, batchReport, all);
        } catch (reportError) {
            console.error('Batch report generation failed; original error:', error, reportError);
        }
        throw error;
    }
    console.log(`Debugger workload evidence: ${batch}`);
}
module.exports = { runStepCapabilities, freePort, waitReady, verifyCleanup };
