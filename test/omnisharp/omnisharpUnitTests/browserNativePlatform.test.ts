/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlazorDebugConfigurationProvider } from '../../../src/razor/src/blazorDebug/blazorDebugConfigurationProvider';
import * as browserBridge from '../../../src/razor/src/blazorDebug/browserBridge';
import { getNullChannel } from '../../fakes';

jest.mock('vscode', () => {
    const { getFakeVsCode, getNullChannel } = jest.requireActual<typeof import('../../fakes')>('../../fakes');
    const fake = getFakeVsCode();
    return {
        ...fake,
        window: { ...fake.window, createOutputChannel: jest.fn(getNullChannel) },
    };
});

jest.mock('fs', () => ({
    ...jest.requireActual<typeof import('fs')>('fs'),
    existsSync: jest.fn(() => false),
}));

describe.each(['win32', 'linux', 'darwin'])('%s native CoreCLR browser selection', (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const logger: vscode.LogOutputChannel = {
        ...getNullChannel(),
        replace: jest.fn(),
        show: jest.fn(),
        logLevel: 3,
        onDidChangeLogLevel: () => ({ dispose: jest.fn() }),
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        jest.spyOn(BlazorDebugConfigurationProvider, 'isCoreClrRuntime').mockResolvedValue(true);
        jest.spyOn(browserBridge, 'findBrowserDebugPort').mockResolvedValue(6002);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        Object.defineProperty(process, 'platform', descriptor);
    });

    test('selects native broker and client assets without a managed proxy binary', async () => {
        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        const project = path.resolve('client', 'Client.csproj');
        const program = path.resolve('client', 'bin', 'Client.dll');
        const result = await provider['createManagedDebugConfigurationOnBrowser'](
            {
                name: 'Client',
                type: 'blazorwasm',
                request: 'attach',
                hosted: true,
                dotNetConfig: { program },
            },
            'http://localhost:5000',
            project
        );
        expect(result.app.type).toBe('coreclr_wasm');
        expect(result.app.coreClrMobileDebuggerOptions).toMatchObject({
            ip: '127.0.0.1',
            port: 6002,
            isServer: false,
            assetsPath: path.dirname(program),
        });
        expect(result.app.remoteBrowserBridge).toMatchObject({
            browserPort: 6002,
            appUrl: 'http://localhost:5000',
            token: result.bridgeToken,
        });
        expect(result.bridgeToken).toBeTruthy();
        expect(result.inspectUri).toBe('');
    });

    test('requires native readiness rather than the legacy Mono bridge export', async () => {
        await expect(
            BlazorDebugConfigurationProvider.tryToUseVSDbgForMono(
                'http://localhost:5000',
                path.resolve('client', 'Client.csproj')
            )
        ).rejects.toThrow('requires the native browser bridge launch');
    });
});
