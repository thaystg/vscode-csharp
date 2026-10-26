/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// User-equivalent Call Stack / Variables view action: real mouse input on an existing tree row, then poll the
// rendered views until the expected content is visible and stable. No DAP request is sent by this helper.
const fs = require('fs');
const [port, output, specJson] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const POLL_MS = 25;
const QUIET_MS = 300;
const BOUND_MS = 30000;

const pageModel = `(() => {
    const panes = [...document.querySelectorAll('.pane')];
    const pane = (re) => panes.find(p => re.test(p.querySelector('.pane-header')?.textContent ?? ''));
    for (const p of [pane(/call stack/i), pane(/variables/i)]) {
        const header = p?.querySelector('.pane-header');
        if (header?.getAttribute('aria-expanded') === 'false') header.click();
    }
    const rows = (p) => [...(p?.querySelectorAll('.monaco-list-row') ?? [])].map((row, index) => {
        const b = row.getBoundingClientRect();
        const twistie = row.querySelector('.monaco-tl-twistie');
        const t = twistie?.getBoundingClientRect();
        return {
            index,
            label: row.getAttribute('aria-label') ?? '',
            text: (row.innerText ?? '').replace(/\\s+/g, ' ').trim(),
            name: (row.querySelector('.name')?.textContent ?? '').replace(/:\\s*$/, '').trim(),
            value: (row.querySelector('.value')?.textContent ?? '').trim(),
            selected: row.getAttribute('aria-selected') === 'true' || row.classList.contains('selected'),
            focused: row.classList.contains('focused'),
            expanded: row.getAttribute('aria-expanded'),
            visible: b.width > 0 && b.height > 0,
            center: { x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2 },
            twistie: t && t.width > 0 ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : undefined,
        };
    });
    return { now: Date.now(), callStack: rows(pane(/call stack/i)), variables: rows(pane(/variables/i)) };
})()`;

function matchesName(row, name) {
    return [row.name, row.label, row.text].some(
        (s) => s === name || s.startsWith(`${name} `) || s.startsWith(`${name},`) || s.startsWith(`${name}:`)
    );
}
function frameRow(model) {
    return model.callStack.find((r) => r.visible && (r.label + ' ' + r.text).includes(spec.callerFrameName));
}
function variableRow(model, name) {
    return model.variables.find((r) => r.visible && matchesName(r, name));
}
const predicates = {
    selectCaller: {
        callerFrameSelected: (m) => !!frameRow(m)?.selected,
        callerLocalsVisible: (m) =>
            spec.callerLocals.every((name) => variableRow(m, name)) &&
            Object.entries(spec.callerLocalContains ?? {}).every(([name, value]) =>
                (variableRow(m, name)?.text ?? '').includes(value)
            ) &&
            !(spec.forbiddenLocals ?? []).some((name) => variableRow(m, name)),
    },
    expandThis: {
        thisMemberVisible: (m) => variableRow(m, 'this')?.expanded === 'true' && !!variableRow(m, spec.thisMember),
    },
};

async function main() {
    const result = { spec, pollMs: POLL_MS, quietMs: QUIET_MS, boundMs: BOUND_MS, conditions: {} };
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
    if (!target) throw new Error('The owned VS Code workbench UI was not found.');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
        }
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
    const model = async () => (await send('Runtime.evaluate', { expression: pageModel, returnByValue: true })).result.value;
    try {
        const conditions = predicates[spec.kind];
        if (!conditions) throw new Error(`Unknown UI action ${spec.kind}.`);
        // Untimed precondition: the row to act on is rendered.
        let before;
        let point;
        const ready = Date.now() + 5000;
        do {
            before = await model();
            const row = spec.kind === 'selectCaller' ? frameRow(before) : variableRow(before, 'this');
            point = spec.kind === 'selectCaller' ? row?.center : row?.expanded === 'false' ? row.twistie : undefined;
            if (point) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < ready);
        result.before = before;
        if (!point && spec.kind === 'expandThis' && variableRow(before, 'this')?.expanded === 'true') {
            throw new Error('Caller this was already expanded before the click (expansion state retained from an earlier break).');
        }
        if (!point) throw new Error(`The ${spec.kind} target row was not rendered in the existing view.`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        result.actionEpochMs = Date.now();
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
        result.actionDispatchedEpochMs = Date.now();
        const state = Object.fromEntries(Object.keys(conditions).map((k) => [k, { firstVisibleEpochMs: undefined, stableSinceEpochMs: undefined, stableEpochMs: undefined }]));
        let last;
        while (Date.now() - result.actionEpochMs < BOUND_MS) {
            last = await model();
            for (const [name, test] of Object.entries(conditions)) {
                const s = state[name];
                if (s.stableEpochMs) continue;
                if (test(last)) {
                    s.firstVisibleEpochMs ??= last.now;
                    s.stableSinceEpochMs ??= last.now;
                    if (last.now - s.stableSinceEpochMs >= QUIET_MS) s.stableEpochMs = last.now;
                } else {
                    if (s.firstVisibleEpochMs) s.regressedAfterVisible = true;
                    s.firstVisibleEpochMs = undefined;
                    s.stableSinceEpochMs = undefined;
                }
            }
            if (Object.values(state).every((s) => s.stableEpochMs)) break;
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        result.conditions = state;
        result.after = last;
        const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(`${output}.png`, Buffer.from(image.data, 'base64'));
        if (!Object.values(state).every((s) => s.stableEpochMs)) {
            throw new Error(`${spec.kind} did not reach correct stable visible content within ${BOUND_MS} ms.`);
        }
    } catch (error) {
        result.failure = String(error);
        throw error;
    } finally {
        fs.writeFileSync(`${output}.json`, JSON.stringify(result, null, 2));
        socket.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
