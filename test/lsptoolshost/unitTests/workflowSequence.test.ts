/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from '@jest/globals';
import { parseDebuggerWorkload, requireWorkflowSecondBreak } from '../integrationTests/debuggerWorkload';
import {
    assertStoppedAt,
    automaticInspectionBreakdown,
    topThisRequestsBefore,
} from '../integrationTests/extendedInspection';
import type { TimedDebuggerRequest } from '../integrationTests/automaticDebuggerSteps';

const havitStops = [15, 16, 18, 19, 20].map((line) => ({ sourceSuffix: 'UrlHelper.cs', line, localNames: ['url'] }));
const havit = {
    id: 'havit',
    workspace: 'havit',
    handoff: 'havit/runtime-handoff.json',
    assembly: 'Havit.Blazor.Documentation',
    url: 'http://127.0.0.1:8001/components/HxGrid',
    preparationTransitions: 2,
    stops: havitStops,
    extendedInspection: {
        callerFrameName: 'DocPageNavigationItemsTracker.',
        callerLocals: ['this', 'url', 'pageKey'],
        forbiddenLocals: ['hashIndex'],
        thisMember: '_itemsByPage',
    },
};
const secondBreak = {
    sourceSuffix: 'SecondBreak.cs',
    line: 30,
    localNames: ['value'],
    callerFrameName: 'Caller.',
    callerLocals: ['this'],
    thisMember: '_field',
    stepOverTo: { sourceSuffix: 'SecondBreak.cs', line: 31, localNames: ['value'] },
};
const small = {
    id: 'small',
    workspace: 'sample',
    handoff: 'sample/runtime-handoff.json',
    assembly: 'Wasm.Browser.Sample',
    url: 'http://127.0.0.1:8000/index.html',
    stops: [15, 16, 17].map((line) => ({ sourceSuffix: 'Program.cs', line, localNames: ['args'] })),
    extendedInspection: { notApplicable: true, notApplicableReason: 'static Main' },
};

describe('Workflow mode second user break', () => {
    test('F10 workloads without a second break still parse and workflow mode rejects them', () => {
        const workload = parseDebuggerWorkload(havit);
        expect(workload.stops.map((s) => s.line)).toEqual([15, 16, 18, 19, 20]);
        expect(() => requireWorkflowSecondBreak(workload)).toThrow(/secondBreak/);
    });
    test('accepts a second break with caller inspection and a Step Over target without changing F10 stops', () => {
        const workload = parseDebuggerWorkload({
            ...havit,
            extendedInspection: { ...havit.extendedInspection, secondBreak },
        });
        expect(requireWorkflowSecondBreak(workload).stepOverTo.line).toBe(31);
        expect(workload.stops).toEqual(havitStops);
        expect(workload.preparationTransitions).toBe(2);
    });
    test('accepts a Small second break whose caller actions are not applicable', () => {
        const smallSecond = {
            sourceSuffix: 'Program.cs',
            line: 25,
            localNames: ['args'],
            notApplicable: true,
            stepOverTo: { sourceSuffix: 'Program.cs', line: 26, localNames: ['args'] },
        };
        const workload = parseDebuggerWorkload({
            ...small,
            extendedInspection: { ...small.extendedInspection, secondBreak: smallSecond },
        });
        expect(requireWorkflowSecondBreak(workload).notApplicable).toBe(true);
    });
    test.each([
        ['missing Step Over target', { ...secondBreak, stepOverTo: undefined }],
        ['missing locals', { ...secondBreak, localNames: [] }],
        ['caller without this', { ...secondBreak, callerLocals: ['url'] }],
        ['caller without this member', { ...secondBreak, thisMember: undefined }],
        ['same location as the first break', { ...secondBreak, sourceSuffix: 'UrlHelper.cs', line: 15 }],
    ])('rejects a second break with %s', (_, invalid) => {
        expect(() =>
            parseDebuggerWorkload({
                ...havit,
                extendedInspection: { ...havit.extendedInspection, secondBreak: invalid },
            })
        ).toThrow();
    });
    test('rejects a second break when the first break caller spec is incomplete', () => {
        expect(() =>
            parseDebuggerWorkload({
                ...havit,
                extendedInspection: { secondBreak } as unknown as typeof havit.extendedInspection,
            })
        ).toThrow(/First break/);
    });
});

describe('Workflow stop validation', () => {
    const body = { reason: 'breakpoint', source: { path: '/src/SecondBreak.cs' }, line: 30 };
    test('returns the reason for the expected location', () => {
        expect(assertStoppedAt(body, secondBreak, 'Second user break')).toBe('breakpoint');
    });
    test.each([
        ['another line', { ...body, line: 31 }],
        ['another file', { ...body, source: { path: '/src/UrlHelper.cs' } }],
        ['no source', { reason: 'breakpoint', line: 30 }],
        ['no body', undefined],
    ])('rejects a stop at %s', (_, wrong) => {
        expect(() => assertStoppedAt(wrong, secondBreak, 'Second user break')).toThrow(/unexpected location/);
    });
});

describe('Automatic inspection breakdown', () => {
    const request = (
        command: string,
        sequence: number,
        startedAt: number,
        finishedAt?: number
    ): TimedDebuggerRequest => ({
        command,
        sequence,
        startedAt,
        finishedAt,
        success: finishedAt !== undefined,
    });
    test('splits threads, call stack, Locals scope and Locals contents from the stop and ignores other windows', () => {
        const requests = [
            request('next', 1, 90, 95),
            request('threads', 2, 101, 103),
            request('stackTrace', 3, 104, 110),
            request('scopes', 4, 500, 501),
            request('variables', 5, 502, 540),
            request('variables', 6, 900, 950),
        ];
        const breakdown = automaticInspectionBreakdown(requests, 100, 600);
        expect(breakdown).toMatchObject({
            threadsAnsweredMs: 3,
            callStackAnsweredMs: 10,
            localsScopeAnsweredMs: 401,
            localsVariablesAnsweredMs: 440,
        });
        expect(breakdown.dap.map((r) => r.command)).toEqual(['threads', 'stackTrace', 'scopes', 'variables']);
        expect(breakdown.dap[0]).toMatchObject({ sequence: 2, startedAtMs: 1, finishedAtMs: 3 });
    });
    test('reports an unanswered request as missing instead of inventing a time', () => {
        const breakdown = automaticInspectionBreakdown([request('stackTrace', 1, 101)], 100, 600);
        expect(breakdown.callStackAnsweredMs).toBeUndefined();
        expect(breakdown.dap).toHaveLength(1);
    });
});

describe('Break-2 order guard (top-frame this before caller select)', () => {
    const variables = (sequence: number, startedAt: number, variablesReference: number): TimedDebuggerRequest => ({
        command: 'variables',
        sequence,
        startedAt,
        finishedAt: startedAt + 5,
        success: true,
        arguments: { variablesReference },
    });
    const topLocals = [
        { name: 'this', variablesReference: 1001 },
        { name: 'url', variablesReference: 0 },
    ];
    test('passes when VS Code only refreshed top Locals before the click (sc1000 v1000 then caller)', () => {
        const check = topThisRequestsBefore([variables(19, 110, 1000), variables(22, 700, 1004)], topLocals, 100, 600);
        expect(check).toEqual({ topThisVariablesReference: 1001, requestsBeforeCallerSelect: [], ok: true });
    });
    test('fails on the g4/b7099245ce82 signature: variables(top this) before the caller click', () => {
        const check = topThisRequestsBefore([variables(19, 110, 1000), variables(20, 130, 1001)], topLocals, 100, 600);
        expect(check.ok).toBe(false);
        expect(check.requestsBeforeCallerSelect).toEqual([{ sequence: 20, startedAtMs: 30 }]);
    });
    test('ignores a top this request after the click and requests before the stop', () => {
        const check = topThisRequestsBefore([variables(9, 50, 1001), variables(30, 650, 1001)], topLocals, 100, 600);
        expect(check.ok).toBe(true);
    });
    test('matches a typed this row and treats a static frame (no this) as passing', () => {
        const typed = [{ name: 'this [DocPageNavigationItemsTracker]', variablesReference: 1001 }];
        expect(topThisRequestsBefore([variables(20, 130, 1001)], typed, 100, 600).ok).toBe(false);
        const statik = topThisRequestsBefore([variables(20, 130, 1001)], [{ name: 'secondMeaning' }], 100, 600);
        expect(statik).toEqual({ topThisVariablesReference: undefined, requestsBeforeCallerSelect: [], ok: true });
    });
});
