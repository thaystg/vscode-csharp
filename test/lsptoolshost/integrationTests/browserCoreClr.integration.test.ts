/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@jest/globals';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CSharpExtensionExports } from '../../../src/csharpExtensionExports';
import { assertRunnableWorkload, parseDebuggerWorkload } from './debuggerWorkload';
import { measureAutomaticDebuggerSteps, TimedDebuggerRequest } from './automaticDebuggerSteps';

const prototypeDirectory = process.env.WASM_PROTOTYPE_DIRECTORY;
const testPrototype = prototypeDirectory ? test : test.skip;
const inspectStepCapabilities = process.env.WASM_PROTOTYPE_STEP_CAPABILITIES === '1';
const inspectEntryOnly = process.env.WASM_PROTOTYPE_ENTRY_ONLY === '1';

testPrototype('The selected browser workload attaches and completes its requested debugger scenario', async () => {
    if (!prototypeDirectory) {
        throw new Error('WASM_PROTOTYPE_DIRECTORY is required.');
    }
    const selector = process.env.WASM_PROTOTYPE_WORKLOAD ?? 'small';
    const browserSessionType = process.env.WASM_PROTOTYPE_BROWSER_TYPE === 'chrome' ? 'pwa-chrome' : 'pwa-msedge';
    if (selector !== 'small' && selector !== 'havit') {
        throw new Error('Select small or havit.');
    }
    const workload = parseDebuggerWorkload(
        JSON.parse(fs.readFileSync(path.join(prototypeDirectory, 'workloads', `${selector}.json`), 'utf8'))
    );
    const handoff = JSON.parse(fs.readFileSync(path.join(prototypeDirectory, workload.handoff), 'utf8'));
    assertRunnableWorkload(handoff);
    const messages: { session: string; message: Record<string, unknown>; at?: number }[] = [];
    // Converts epoch stamps from other owned processes (UI/navigation helpers) into this host's performance.now().
    const epochOffsetMs = Date.now() - performance.now();
    let launchStartedAt: number | undefined;
    const browserMessages: { session: string; message: Record<string, unknown> }[] = [];
    const sessions: vscode.DebugSession[] = [];
    const disposables: vscode.Disposable[] = [];
    const run = process.env.WASM_PROTOTYPE_RUN_DIRECTORY ?? prototypeDirectory;
    const timedRequests: TimedDebuggerRequest[] = [];
    const pending = new Map<number, TimedDebuggerRequest>();
    const stopTimes: number[] = [];
    let failure: string | undefined;
    let smokeSucceeded = false;
    let stepCapabilitiesCheckPassed = false;
    let userBreakObserved = false;
    let continuedAfterUserBreak = false;
    let browserDomObservation: unknown;
    let automaticSteps: Awaited<ReturnType<typeof measureAutomaticDebuggerSteps>> | undefined;
    let entryTriggered = false;
    let entryDomObservation: unknown;
    let historyNavigationObserved = false;
    let entryCapabilitiesCheckPassed = false;
    async function readEntryDom(browser: vscode.DebugSession, expression: string): Promise<{ result?: unknown }> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                browser.customRequest('evaluate', { expression, context: 'repl' }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error('Untimed browser DOM readiness request did not receive a response within10s.')
                            ),
                        10000
                    );
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    disposables.push(
        vscode.debug.onDidStartDebugSession((session) => sessions.push(session)),
        vscode.debug.registerDebugAdapterTrackerFactory('coreclr_wasm', {
            createDebugAdapterTracker(session) {
                return {
                    onWillReceiveMessage(message) {
                        if (message.type === 'request') {
                            const record: TimedDebuggerRequest = {
                                command: message.command,
                                sequence: message.seq,
                                arguments: message.arguments,
                                startedAt: performance.now(),
                            };
                            timedRequests.push(record);
                            pending.set(record.sequence, record);
                        }
                    },
                    onDidSendMessage(message) {
                        messages.push({ session: session.id, message, at: performance.now() });
                        if (message.type === 'event' && message.event === 'stopped') {
                            stopTimes.push(performance.now());
                        }
                        if (message.type === 'response') {
                            const record = pending.get(message.request_seq);
                            if (record) {
                                record.finishedAt = performance.now();
                                record.success = message.success;
                                pending.delete(message.request_seq);
                            }
                        }
                        if (message.type !== 'event' || message.event !== 'output') {
                            console.log('CORECLR DAP: ' + JSON.stringify(message));
                        }
                    },
                    onError(error) {
                        failure = error.message;
                    },
                };
            },
        }),
        vscode.debug.registerDebugAdapterTrackerFactory(browserSessionType, {
            createDebugAdapterTracker(session) {
                return {
                    onDidSendMessage(message) {
                        if (message.type === 'event') {
                            browserMessages.push({ session: session.id, message });
                        }
                    },
                };
            },
        })
    );
    try {
        const extension = vscode.extensions.getExtension<CSharpExtensionExports>('ms-dotnettools.csharp');
        if (!extension) {
            throw new Error('The staged C# extension was not loaded.');
        }
        expect(extension.packageJSON.runtimeDependencies).toEqual([]);
        await extension.activate();
        const readyDeadline = Date.now() + 30000;
        let ready = false;
        while (Date.now() < readyDeadline) {
            const commands = await vscode.commands.getCommands();
            if (commands.includes('csharp.attachToProcess') && commands.includes('dotnet.generateAssets')) {
                ready = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(ready).toBe(true);
        if (inspectStepCapabilities) {
            await vscode.commands.executeCommand('workbench.view.debug');
            const commands = await vscode.commands.getCommands();
            for (const command of commands.filter((c) => /callstack|variables/i.test(c) && c.endsWith('.focus'))) {
                await vscode.commands.executeCommand(command);
            }
        }
        const workspace = path.join(prototypeDirectory, workload.workspace);
        const launch = JSON.parse(fs.readFileSync(path.join(workspace, '.vscode', 'launch.json'), 'utf8'))
            .configurations[0];
        delete launch.preLaunchTask;
        launch.url = workload.url;
        launch.dotNetConfig = {
            ...launch.dotNetConfig,
            justMyCode: true,
            logging: {
                diagnosticsLog: { protocolMessages: true },
                ...(process.env.WASM_PROTOTYPE_DIAGNOSTIC_LOGGING === '1' ? { elapsedTiming: true } : {}),
            },
        };
        launch.browserConfig = {
            ...launch.browserConfig,
            runtimeExecutable: process.env.WASM_PROTOTYPE_BROWSER,
            runtimeArgs: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
            userDataDir: process.env.WASM_PROTOTYPE_BROWSER_PROFILE || path.join(run, 'browser-profile'),
        };
        expect(process.env.WASM_PROTOTYPE_BROWSER).toBeTruthy();
        // VS Code's Uri.fsPath lowercases the Windows drive letter; compare it case-insensitively only.
        const normalizeDrive = (value: string | undefined) =>
            process.platform === 'win32' && value ? value.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : value;
        expect(normalizeDrive(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)).toBe(normalizeDrive(workspace));
        launchStartedAt = performance.now();
        expect(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], launch)).toBe(true);

        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            if (failure) {
                throw new Error(failure);
            }
            const failed = messages.find(
                ({ message }) =>
                    message.type === 'response' &&
                    !message.success &&
                    ['initialize', 'launch', 'configurationDone', 'continue'].includes(String(message.command))
            );
            if (failed) {
                throw new Error('Managed request failed: ' + JSON.stringify(failed.message));
            }
            const appLoaded = messages.some(
                ({ message }) =>
                    message.type === 'event' &&
                    message.event === 'module' &&
                    JSON.stringify(message.body).includes(workload.assembly)
            );
            const attachConfigured = messages.some(
                ({ message }) =>
                    message.type === 'response' && message.command === 'configurationDone' && message.success === true
            );
            if (workload.entry && !entryTriggered && appLoaded && attachConfigured) {
                const browsers = sessions.filter((session) => session.type === browserSessionType);
                const browser = browsers.length > 1 ? browsers[browsers.length - 1] : undefined;
                if (browser) {
                    // A synchronous user break must not block acknowledgment of the untimed anchor trigger.
                    const expression = `(() => {
                        const elements = document.querySelectorAll(${JSON.stringify(workload.entry.selector)});
                        const element = elements[0];
                        const table = element?.closest("table");
                        const rows = table ? [...table.querySelectorAll("tbody tr")].map(row => (row.querySelector("td")?.innerText ?? "").replace(/\\s+/g," ").trim()) : [];
                        const marker = ${workload.entry.readyMarker ? `globalThis[${JSON.stringify(workload.entry.readyMarker)}]` : 'true'};
                        const expected = ${JSON.stringify(workload.entry.initialRows ?? [])};
                        const bounds = element?.getBoundingClientRect();
                        const visible = !!bounds && bounds.width>0 && bounds.height>0;
                        const label = element?.textContent?.replace(/\\s+/g," ").trim();
                        const snapshot = {time:Date.now(),marker,elementCount:elements.length,connected:element?.isConnected,visible,text:label,viewport:{width:innerWidth,height:innerHeight},value:element?.value,href:element?.href,location:location.href,rows};
                        if (!marker || elements.length!==1 || !element.isConnected ||
                            !visible || innerWidth<${workload.entry.minimumViewportWidth ?? 1} ||
                            ${workload.entry.expectedText ? `label!==${JSON.stringify(workload.entry.expectedText)} ||` : ''}
                            ${workload.entry.action === 'click' ? `(element.tagName!=="A" || !element.href.endsWith(${JSON.stringify(workload.entry.expectedHrefSuffix)})) ||` : ''}
                            (expected.length && JSON.stringify(rows)!==JSON.stringify(expected))) {
                            return JSON.stringify({status:"waiting-for-existing-ui-readiness",snapshot});
                        }
                        element.scrollIntoView({block:"center"});
                        element.focus();
                        ${
                            workload.entry.action === 'click'
                                ? 'setTimeout(() => element.click(), 0);'
                                : `
                            element.value = ${JSON.stringify(workload.entry.text)};
                            element.dispatchEvent(new Event("input", {bubbles:true}));
                        `
                        }
                        return JSON.stringify({status:"existing-ui-triggered",action:${JSON.stringify(workload.entry.action ?? 'input')},clickScheduledForNextJsTurn:${workload.entry.action === 'click'},before:snapshot,triggerAcknowledgedAt:Date.now(),value:element.value,href:element.href,location:location.href});
                    })()`;
                    const result = await readEntryDom(browser, expression);
                    fs.writeFileSync(
                        path.join(run, 'entry-pretrigger-observation.json'),
                        JSON.stringify(result, null, 2)
                    );
                    if (String(result.result).includes('"status":"existing-ui-triggered"')) {
                        entryTriggered = true;
                        fs.writeFileSync(path.join(run, 'entry-result.json'), JSON.stringify(result));
                    }
                }
            }
            if (workload.entry?.historyRoundTrip && entryTriggered && !historyNavigationObserved) {
                if (!process.env.WASM_PROTOTYPE_NODE) {
                    throw new Error('Owned Node navigation helper missing.');
                }
                const output = browserMessages
                    .map(({ message }) => {
                        const body = message.body;
                        return body && typeof body === 'object' && 'output' in body && typeof body.output === 'string'
                            ? body.output
                            : '';
                    })
                    .join('\n');
                const ownerBrowserWs = output.match(
                    /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/
                )?.[1];
                if (!ownerBrowserWs) {
                    throw new Error('Fresh owned browser DevTools address was not captured.');
                }
                await promisify(execFile)(
                    process.env.WASM_PROTOTYPE_NODE,
                    [
                        path.join(prototypeDirectory, 'navigateWorkloadHistory.js'),
                        ownerBrowserWs,
                        workload.url,
                        new URL(workload.entry.expectedHrefSuffix!, workload.url).href,
                        path.join(run, 'ordinary-history-navigation.json'),
                    ],
                    { timeout: 20000 }
                );
                historyNavigationObserved = true;
            }
            if (workload.entry && entryTriggered && !userBreakObserved) {
                const browser = [...sessions].reverse().find((session) => session.type === browserSessionType);
                if (browser) {
                    entryDomObservation = await readEntryDom(
                        browser,
                        `(() => {
                            const input = document.querySelector(${JSON.stringify(workload.entry.selector)});
                            const table = input?.closest("table");
                            const rows = table ? [...table.querySelectorAll("tbody tr")].map(row => row.querySelector("td")?.innerText ?? "") : [];
                            return JSON.stringify({time:Date.now(),value:input?.value,href:input?.href,location:location.href,rows,allRowsMatch:rows.length>0 && rows.every(row => row.toLowerCase().includes(${JSON.stringify(workload.entry.text?.toLowerCase() ?? '')})),expectedRows:${JSON.stringify(workload.entry.expectedRows ?? [])}});
                        })()`
                    );
                    fs.writeFileSync(
                        path.join(run, 'entry-dom-observation.json'),
                        JSON.stringify(entryDomObservation, null, 2)
                    );
                }
            }
            const stopped = messages.find(({ message }) => message.type === 'event' && message.event === 'stopped');
            if (stopped && !userBreakObserved) {
                const body = stopped.message.body;
                if (!body || typeof body !== 'object' || !('threadId' in body) || typeof body.threadId !== 'number') {
                    throw new Error('Managed user break did not identify a thread.');
                }
                userBreakObserved = true;
                const session = sessions.find((session) => session.id === stopped.session);
                if (!session) {
                    throw new Error('Stopped managed session is unavailable.');
                }
                if (inspectEntryOnly) {
                    const expected = workload.stops[0];
                    if (
                        !('source' in body) ||
                        !body.source ||
                        typeof body.source !== 'object' ||
                        !('path' in body.source) ||
                        typeof body.source.path !== 'string' ||
                        !body.source.path.endsWith(expected.sourceSuffix) ||
                        !('line' in body) ||
                        body.line !== expected.line
                    ) {
                        throw new Error(
                            `Guarded workload entry stopped at an unexpected context: ${JSON.stringify(body)}`
                        );
                    }
                    const deadline = Date.now() + 10000;
                    let idleSince: number | undefined;
                    while (Date.now() < deadline) {
                        const busy = [...pending.values()].some((r) =>
                            ['threads', 'stackTrace', 'scopes', 'variables'].includes(r.command)
                        );
                        if (busy) {
                            idleSince = undefined;
                        } else {
                            idleSince ??= Date.now();
                        }
                        if (idleSince !== undefined && Date.now() - idleSince >= 300) {
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    if (!process.env.WASM_PROTOTYPE_NODE || !process.env.WASM_PROTOTYPE_UI_PORT) {
                        throw new Error('Owned UI capture prerequisites missing.');
                    }
                    await promisify(execFile)(
                        process.env.WASM_PROTOTYPE_NODE,
                        [
                            path.join(prototypeDirectory, 'captureUi.js'),
                            process.env.WASM_PROTOTYPE_UI_PORT,
                            path.join(run, 'entry-ui'),
                        ],
                        { timeout: 12000 }
                    );
                    entryCapabilitiesCheckPassed = true;
                    return;
                }
                if (inspectStepCapabilities) {
                    automaticSteps = await measureAutomaticDebuggerSteps(
                        session,
                        workload,
                        prototypeDirectory,
                        run,
                        messages,
                        timedRequests,
                        stopTimes,
                        pending,
                        { launchStartedAt: launchStartedAt!, epochOffsetMs }
                    );
                    stepCapabilitiesCheckPassed = true;
                    return;
                }
                await session.customRequest('continue', { threadId: body.threadId });
                continuedAfterUserBreak = true;
            }
            const output = browserMessages.map(({ message }) => JSON.stringify(message.body)).join('\n');
            if (
                !inspectStepCapabilities &&
                workload.id === 'small' &&
                continuedAfterUserBreak &&
                output.includes('Meaning of life is 42') &&
                output.includes('WASM EXIT 0')
            ) {
                const browser = [...sessions].reverse().find((session) => session.type === browserSessionType);
                if (browser) {
                    browserDomObservation = await browser.customRequest('evaluate', {
                        expression:
                            "JSON.stringify({value:document.getElementById('out')?.textContent,testsDone:document.getElementById('tests_done')?.textContent})",
                        context: 'repl',
                    });
                }
                smokeSucceeded = true;
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Selected workload did not reach its requested managed debugger scenario.');
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        fs.writeFileSync(
            path.join(run, 'managed-attach-result.json'),
            JSON.stringify(
                {
                    batchId: process.env.WASM_PROTOTYPE_BATCH_ID,
                    runId: process.env.WASM_PROTOTYPE_RUN_ID,
                    workload,
                    validationMode: inspectEntryOnly
                        ? 'managed-entry-only'
                        : inspectStepCapabilities
                          ? 'automatic-ui-stepping'
                          : 'attach-and-run',
                    entryTriggered,
                    entryDomObservation,
                    historyNavigationObserved,
                    entryCapabilitiesCheckPassed,
                    smokeSucceeded,
                    stepCapabilitiesCheckPassed,
                    userBreakObserved,
                    continuedAfterUserBreak,
                    browserDomObservation,
                    failure,
                    automaticSteps,
                    timedRequests,
                    messages,
                    browserMessages,
                    sessions: sessions.map((session) => ({
                        id: session.id,
                        type: session.type,
                        configuration: session.configuration,
                    })),
                    inspectionFailures: messages.filter(
                        ({ message }) => message.type === 'response' && message.success === false
                    ),
                    automaticInspectionOnly: true,
                    explicitInspectionRequests: 0,
                    uiDrivenExtendedInspection: process.env.WASM_PROTOTYPE_EXTENDED_ACTIONS === '1',
                    epochOffsetMs,
                    launchStartedAt,
                },
                null,
                2
            )
        );
        await vscode.debug.stopDebugging();
        disposables.forEach((disposable) => disposable.dispose());
    }
});
