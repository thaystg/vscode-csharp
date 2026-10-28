/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CallerInspectionSpec, DebuggerStopExpectation, DebuggerWorkload } from './debuggerWorkload';
import type { TimedDebuggerRequest } from './automaticDebuggerSteps';

type Message = { session: string; message: Record<string, unknown>; at?: number };
type Frame = { id: number; name: string; line: number };

export interface ExtendedInspectionContext {
    launchStartedAt: number;
    // Date.now() - performance.now() sampled in this extension host; converts other processes' epoch stamps.
    epochOffsetMs: number;
}

export function requestsBetween(requests: TimedDebuggerRequest[], from: number, to: number) {
    return requests
        .filter((r) => r.startedAt >= from && r.startedAt <= to)
        .map((r) => ({
            command: r.command,
            sequence: r.sequence,
            arguments: r.arguments,
            startedAtMs: r.startedAt - from,
            finishedAtMs: r.finishedAt === undefined ? undefined : r.finishedAt - from,
            success: r.success,
        }));
}

/** Validates a managed stopped event body against the expected workload location. */
export function assertStoppedAt(body: unknown, expected: DebuggerStopExpectation, label: string): string {
    const b = body as { reason?: unknown; source?: { path?: unknown }; line?: unknown } | undefined;
    if (
        !b ||
        typeof b.source?.path !== 'string' ||
        !b.source.path.endsWith(expected.sourceSuffix) ||
        b.line !== expected.line
    ) {
        throw new Error(
            `${label} stopped at an unexpected location (expected ${expected.sourceSuffix}:${expected.line}): ${JSON.stringify(body)}`
        );
    }
    return String(b.reason);
}

/**
 * Splits VS Code's automatic top-frame refresh after a stop into the comparison's rows: threads, call stack
 * (stackTrace), Locals scope (scopes) and Locals contents (variables), each measured from the given start.
 */
export function automaticInspectionBreakdown(
    requests: TimedDebuggerRequest[],
    stopAt: number,
    completedAt: number,
    start = stopAt
) {
    const window = requests.filter(
        (r) => r.startedAt >= stopAt && r.startedAt <= completedAt && r.command !== 'next' && r.command !== 'continue'
    );
    const answered = (command: string) => {
        const request = window.find((r) => r.command === command && r.finishedAt !== undefined);
        return request ? request.finishedAt! - start : undefined;
    };
    return {
        threadsAnsweredMs: answered('threads'),
        callStackAnsweredMs: answered('stackTrace'),
        localsScopeAnsweredMs: answered('scopes'),
        localsVariablesAnsweredMs: answered('variables'),
        dap: requestsBetween(window, stopAt, completedAt),
    };
}

/** Launch, Debugger.Break pause and automatic top-frame Locals boundaries from already-recorded events. */
export function launchAndBreakTimings(
    workload: DebuggerWorkload,
    run: string,
    messages: Message[],
    requests: TimedDebuggerRequest[],
    stopTimes: number[],
    context: ExtendedInspectionContext
) {
    const stopAt = stopTimes[0];
    const launch = {
        definition:
            'harness vscode.debug.startDebugging call -> first managed stopped event (validated at the Debugger.Break line)',
        launchToInitialStopMs: stopAt - context.launchStartedAt,
    };
    if (workload.id === 'havit') {
        const history = JSON.parse(fs.readFileSync(path.join(run, 'ordinary-history-navigation.json'), 'utf8'));
        const forward = history.operations.find((o: { action: string }) => o.action === 'Forward');
        if (!forward?.issuedAtEpochMs) {
            throw new Error('Scripted Forward history navigation timestamp is missing.');
        }
        const triggerAt = forward.issuedAtEpochMs - context.epochOffsetMs;
        return {
            launch: {
                ...launch,
                launchToTriggerMs: triggerAt - context.launchStartedAt,
                triggerToInitialStopMs: stopAt - triggerAt,
                remainderDefinition:
                    'startDebugging -> scripted Forward issued (includes untimed anchor click/Back preparation)',
            },
            pauseAtDebuggerBreak: {
                definition:
                    'navigateWorkloadHistory Forward Page.navigateToHistoryEntry issued (#header-filtering, the only entry satisfying the break guard) -> managed stopped event at UrlHelper.cs:15',
                triggerToStopMs: stopAt - triggerAt,
                clockNote: 'helper Date.now() converted with this extension host Date.now()-performance.now() offset',
            },
        };
    }
    const configurationDone = requests.find((r) => r.command === 'configurationDone');
    if (!configurationDone) {
        throw new Error('configurationDone request was not recorded.');
    }
    const stopIndex = messages.findIndex(({ message }) => message.type === 'event' && message.event === 'stopped');
    const lastModule = messages
        .slice(0, stopIndex)
        .filter(({ message }) => message.type === 'event' && message.event === 'module')
        .pop();
    return {
        launch,
        pauseAtDebuggerBreak: {
            definition:
                'managed configurationDone request sent (runtime resumes startup; Main runs Debugger.Break during startup) -> managed stopped event at Program.cs:15',
            configurationDoneToStopMs: stopAt - configurationDone.startedAt,
            supplementaryLastModuleEventToStopMs: lastModule?.at === undefined ? undefined : stopAt - lastModule.at,
            supplementaryDefinition:
                'last managed module event before the stop -> stopped (closer to Main executing Debugger.Break)',
        },
    };
}

/**
 * Break-2 order evidence: variables requests for the top-frame `this` that VS Code issued between the stop and the
 * caller-row click. Expanding top `this` runs a func-eval that neuters DBI frames, after which Concord cannot
 * evaluate the caller's arguments (known Concord frame-identity bug; this check detects its trigger, it does not fix it).
 */
export function topThisRequestsBefore(
    requests: TimedDebuggerRequest[],
    topLocals: { name: string; variablesReference?: number }[],
    from: number,
    to: number
) {
    const topThis = topLocals.find((v) => v.name === 'this' || v.name.startsWith('this '));
    const reference = topThis?.variablesReference || undefined;
    const early =
        reference === undefined
            ? []
            : requests
                  .filter(
                      (r) =>
                          r.command === 'variables' &&
                          r.arguments?.variablesReference === reference &&
                          r.startedAt >= from &&
                          r.startedAt < to
                  )
                  .map((r) => ({ sequence: r.sequence, startedAtMs: r.startedAt - from }));
    return { topThisVariablesReference: reference, requestsBeforeCallerSelect: early, ok: early.length === 0 };
}

async function uiAction(
    prototype: string,
    run: string,
    requests: TimedDebuggerRequest[],
    context: ExtendedInspectionContext,
    label: string,
    uiSpec: Record<string, unknown>
) {
    const output = path.join(run, label);
    await promisify(execFile)(
        process.env.WASM_PROTOTYPE_NODE!,
        [
            path.join(prototype, 'uiInspectAction.js'),
            process.env.WASM_PROTOTYPE_UI_PORT!,
            output,
            JSON.stringify(uiSpec),
        ],
        { timeout: 45000 }
    );
    const ui = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
    const actionAt = ui.actionEpochMs - context.epochOffsetMs;
    const stableAt =
        Math.max(
            ...Object.values(ui.conditions as Record<string, { stableEpochMs: number }>).map((c) => c.stableEpochMs)
        ) - context.epochOffsetMs;
    return { ui, actionAt, stableAt, dap: requestsBetween(requests, actionAt - 5, stableAt) };
}

/**
 * WORKFLOW CHANGE (unscored): collapse the caller `this` expanded by callerInspectionSequence, through the real
 * twistie, and wait until the Variables view shows it collapsed (300 ms quiet).
 */
export async function collapseCallerThis(
    spec: CallerInspectionSpec,
    prototype: string,
    run: string,
    requests: TimedDebuggerRequest[],
    context: ExtendedInspectionContext,
    labelPrefix: string
) {
    const collapse = await uiAction(prototype, run, requests, context, `${labelPrefix}-collapse-caller-this`, {
        kind: 'collapseThis',
        thisMember: spec.thisMember,
    });
    return {
        unscored: true,
        workflowChange:
            'Added 2026-10-28: collapse caller `this` after its measurement so VS Code does not restore the expansion (and func-eval top-frame `this`) at the next stop.',
        definition: `mouse click on the expanded this twistie -> this collapsed and ${spec.thisMember} row gone (first poll), stable 300 ms`,
        actionToCollapsedMs:
            collapse.ui.conditions.thisCollapsed.firstVisibleEpochMs - context.epochOffsetMs - collapse.actionAt,
        dap: collapse.dap,
    };
}

/** Caller inspection at the current stop, driven through the Call Stack/Variables UI with real mouse input. */
export async function callerInspectionSequence(
    spec: CallerInspectionSpec | undefined,
    prototype: string,
    run: string,
    messages: Message[],
    requests: TimedDebuggerRequest[],
    context: ExtendedInspectionContext,
    labelPrefix = 'inspect'
) {
    if (!spec || spec.notApplicable) {
        return {
            notApplicable: ['Select caller frame', 'Load caller locals', 'Expand caller this'],
            reason: spec?.notApplicableReason ?? 'No managed caller frame.',
        };
    }
    if (!process.env.WASM_PROTOTYPE_UI_PORT || !process.env.WASM_PROTOTYPE_NODE) {
        throw new Error('Owned UI inspection port and Node executable required.');
    }
    const stack = [...messages]
        .reverse()
        .find(({ message }) => message.type === 'response' && message.command === 'stackTrace' && message.success)
        ?.message.body as { stackFrames: Frame[] } | undefined;
    const caller = stack?.stackFrames?.[1];
    if (!caller || !caller.name.includes(spec.callerFrameName!)) {
        throw new Error(`Unexpected caller frame: ${JSON.stringify(caller)}`);
    }
    const responseFor = (from: number, command: string, predicate: (args: Record<string, unknown>) => boolean) => {
        const request = requests.find(
            (r) => r.startedAt >= from && r.command === command && predicate(r.arguments ?? {})
        );
        const response = messages.find(
            ({ message }) => message.type === 'response' && message.request_seq === request?.sequence
        )?.message;
        return { request, response };
    };
    async function act(label: string, uiSpec: Record<string, unknown>) {
        return uiAction(prototype, run, requests, context, label, uiSpec);
    }

    const select = await act(`${labelPrefix}-select-caller`, {
        kind: 'selectCaller',
        callerFrameName: spec.callerFrameName,
        callerLocals: spec.callerLocals,
        callerLocalContains: spec.callerLocalContains,
        forbiddenLocals: spec.forbiddenLocals,
    });
    const scopes = responseFor(select.actionAt - 5, 'scopes', (a) => a.frameId === caller.id);
    const scopeBody = scopes.response?.body as { scopes?: { name: string; variablesReference: number }[] } | undefined;
    const localsScope = scopeBody?.scopes?.find((s) => /locals/i.test(s.name));
    const locals =
        localsScope &&
        responseFor(select.actionAt - 5, 'variables', (a) => a.variablesReference === localsScope.variablesReference);
    const localVariables =
        (locals?.response?.body as { variables?: { name: string; variablesReference: number }[] } | undefined)
            ?.variables ?? [];
    const thisVariable = localVariables.find((v) => v.name === 'this' || v.name.startsWith('this '));
    if (!scopes.response?.success || !locals?.response?.success || !thisVariable?.variablesReference) {
        throw new Error(
            'Caller frame selection did not produce successful caller scopes/Locals with an expandable this.'
        );
    }
    for (const name of spec.callerLocals!) {
        if (!localVariables.some((v) => v.name === name || v.name.startsWith(`${name} `))) {
            throw new Error(`Caller local ${name} missing from the DAP reply.`);
        }
    }
    const expand = await act(`${labelPrefix}-expand-caller-this`, { kind: 'expandThis', thisMember: spec.thisMember });
    const members = responseFor(
        expand.actionAt - 5,
        'variables',
        (a) => a.variablesReference === thisVariable.variablesReference
    );
    const memberVariables = (members.response?.body as { variables?: { name: string }[] } | undefined)?.variables ?? [];
    if (
        !members.response?.success ||
        !memberVariables.some((v) => v.name === spec.thisMember || v.name.startsWith(`${spec.thisMember} `))
    ) {
        throw new Error(`Expanding caller this did not return ${spec.thisMember}.`);
    }
    const visible = (r: typeof select, condition: string) =>
        r.ui.conditions[condition].firstVisibleEpochMs - context.epochOffsetMs - r.actionAt;
    return {
        callerFrame: caller,
        selectCallerFrame: {
            definition:
                'mouse click on the caller row in the Call Stack view -> caller row rendered selected (first poll), stable 300 ms',
            actionToVisibleMs: visible(select, 'callerFrameSelected'),
            actionToDapScopesMs:
                scopes.request?.finishedAt === undefined ? undefined : scopes.request.finishedAt - select.actionAt,
            dap: select.dap,
        },
        loadCallerLocals: {
            definition: `same click -> Variables view shows caller Locals (${spec.callerLocals!.join(', ')}${
                spec.forbiddenLocals?.length ? `; no top-frame ${spec.forbiddenLocals.join(', ')}` : ''
            }) (first poll), stable 300 ms`,
            actionToVisibleMs: visible(select, 'callerLocalsVisible'),
            actionToDapVariablesMs:
                locals.request?.finishedAt === undefined ? undefined : locals.request.finishedAt - select.actionAt,
            dap: select.dap,
        },
        expandCallerThis: {
            definition: `mouse click on the this twistie in the Variables view -> ${spec.thisMember} row visible under expanded this (first poll), stable 300 ms`,
            actionToVisibleMs: visible(expand, 'thisMemberVisible'),
            actionToDapVariablesMs:
                members.request?.finishedAt === undefined ? undefined : members.request.finishedAt - expand.actionAt,
            dap: expand.dap,
        },
    };
}
