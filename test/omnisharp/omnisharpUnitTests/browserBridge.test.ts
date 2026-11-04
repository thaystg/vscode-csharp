/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, expect } from '@jest/globals';
import { createServer } from 'net';
import * as path from 'path';
import {
    findBrowserDebugPort,
    getCoreClrBrowserProgram,
    parseBrowserBridgeReady,
} from '../../../src/razor/src/blazorDebug/browserBridge';

describe('CoreCLR hosted client project resolution', () => {
    const projectPath = path.resolve('client', 'Client.csproj');
    const outputPath = path.resolve('client', 'custom-output', 'Client.dll');
    const client = { projectPath, outputPath };
    const server = {
        projectPath: path.resolve('server', 'Server.csproj'),
        outputPath: path.resolve('server', 'bin', 'Server.dll'),
    };

    test('selects the exact client output rather than the first server project', () => {
        expect(getCoreClrBrowserProgram([server, client], projectPath)).toBe(outputPath);
    });

    test('normalizes client project paths', () => {
        expect(getCoreClrBrowserProgram([client], path.join(path.dirname(projectPath), '.', 'Client.csproj'))).toBe(
            outputPath
        );
    });

    test.each([undefined, [], [server], [client, client]])(
        'rejects unavailable or ambiguous client: %p',
        (projects) => {
            expect(() => getCoreClrBrowserProgram(projects, projectPath)).toThrow('Load and build that client project');
        }
    );

    test.each(['', path.join('relative', 'Client.dll')])('rejects an invalid output path: %s', (outputPath) => {
        expect(() => getCoreClrBrowserProgram([{ projectPath, outputPath }], projectPath)).toThrow();
    });
});

describe('Native browser bridge startup', () => {
    const browserPort = 9223;
    const inspectUri = 'ws://127.0.0.1:45678/ws-proxy?browser={browserInspectUri}';

    test('accepts a matching loopback relay', () => {
        expect(parseBrowserBridgeReady({ success: true, browserPort, inspectUri }, browserPort)).toBe(inspectUri);
    });

    test.each([undefined, null, '', 0, {}, { success: false }])('rejects invalid readiness: %p', (body) => {
        expect(() => parseBrowserBridgeReady(body, browserPort)).toThrow();
    });

    test('preserves the native error message', () => {
        expect(() =>
            parseBrowserBridgeReady({ success: false, error: 'Port is already in use.' }, browserPort)
        ).toThrow('Port is already in use.');
    });

    test('rejects a different browser port', () => {
        expect(() => parseBrowserBridgeReady({ success: true, browserPort: 9224, inspectUri }, browserPort)).toThrow();
    });

    test.each([
        'ws://example.com:45678/ws-proxy?browser={browserInspectUri}',
        'wss://127.0.0.1:45678/ws-proxy?browser={browserInspectUri}',
        'ws://user:password@127.0.0.1:45678/ws-proxy?browser={browserInspectUri}',
        'ws://127.0.0.1:45678/other?browser={browserInspectUri}',
        'ws://127.0.0.1:45678/ws-proxy?browser=unrelated',
        'ws://127.0.0.1:45678/ws-proxy?browser={browserInspectUri}#fragment',
    ])('rejects an invalid relay URI: %s', (uri) => {
        expect(() => parseBrowserBridgeReady({ success: true, browserPort, inspectUri: uri }, browserPort)).toThrow();
    });

    test('allocates a browser port without retaining a listener', async () => {
        const port = await findBrowserDebugPort();
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThanOrEqual(65535);
        await new Promise<void>((resolve, reject) => {
            const server = createServer();
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        });
    });
});
