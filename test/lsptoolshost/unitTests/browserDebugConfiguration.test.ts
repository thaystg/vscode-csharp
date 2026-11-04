/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { URI } from 'vscode-uri';
import { BlazorDebugConfigurationProvider } from '../../../src/razor/src/blazorDebug/blazorDebugConfigurationProvider';
import { BaseVsDbgConfigurationProvider } from '../../../src/shared/configurationProvider';
import { PlatformInformation } from '../../../src/shared/platform';
import { setExtensionPath } from '../../../src/common';
import { getNullChannel } from '../../fakes';
import * as browserBridge from '../../../src/razor/src/blazorDebug/browserBridge';
import type { ProjectDebugInformation } from '../../../src/shared/IWorkspaceDebugInformationProvider';

jest.mock('vscode', () => {
    const { getFakeVsCode, getNullChannel, getWorkspaceConfiguration } =
        jest.requireActual<typeof import('../../fakes')>('../../fakes');
    const fake = getFakeVsCode();
    return {
        ...fake,
        UIKind: { Desktop: 1, Web: 2 },
        window: { ...fake.window, createOutputChannel: jest.fn(getNullChannel) },
        workspace: {
            ...fake.workspace,
            getWorkspaceFolder: jest.fn(),
            getConfiguration: jest.fn(getWorkspaceConfiguration),
        },
        extensions: { ...fake.extensions, getExtension: jest.fn() },
        commands: { executeCommand: jest.fn(async () => ({ dotnetPath: '/dotnet/dotnet' })) },
        CancellationError: class extends Error {
            constructor() {
                super('Canceled');
            }
        },
        debug: {
            startDebugging: jest.fn(async () => true),
            stopDebugging: jest.fn(async () => undefined),
            onDidReceiveDebugSessionCustomEvent: jest.fn(() => ({ dispose: jest.fn() })),
            onDidStartDebugSession: jest.fn(() => ({ dispose: jest.fn() })),
            onDidTerminateDebugSession: jest.fn(() => ({ dispose: jest.fn() })),
        },
    };
});

jest.mock('fs', () => ({
    ...jest.requireActual<typeof import('fs')>('fs'),
    existsSync: jest.fn(() => true),
}));

jest.mock('child_process', () => {
    const { EventEmitter } = jest.requireActual<typeof import('events')>('events');
    const { PassThrough } = jest.requireActual<typeof import('stream')>('stream');
    return {
        ...jest.requireActual<typeof import('child_process')>('child_process'),
        spawn: jest.fn(() => {
            const stdout = new PassThrough();
            queueMicrotask(() => {
                stdout.write(
                    'Listening iCorDebug on: 6001\nWaiting for browser on: 6002\nNow listening on: http://127.0.0.1:6003\n'
                );
            });
            return Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough() });
        }),
    };
});

describe('Browser debug configuration', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const workspacePath = path.resolve('testWorkspace');
    const program = path.join(workspacePath, 'bin', 'App.dll');
    const assetsPath = path.join(workspacePath, 'wwwroot', '_framework');
    const folder: vscode.WorkspaceFolder = { name: 'App', uri: URI.file(workspacePath), index: 0 };
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
    let workspaceProvider: BaseVsDbgConfigurationProvider;

    beforeEach(() => {
        jest.clearAllMocks();
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        setExtensionPath(workspacePath);
        jest.spyOn(BlazorDebugConfigurationProvider, 'isCoreClrRuntime').mockResolvedValue(true);
        workspaceProvider = new BaseVsDbgConfigurationProvider(new PlatformInformation('darwin', 'arm64'), logger);
        jest.spyOn(workspaceProvider, 'isDotnetWorkspaceConfigurationProvider').mockReturnValue(true);
        jest.spyOn(workspaceProvider, 'getNet9WasmAssetsPathAndProgram').mockResolvedValue([
            path.dirname(program),
            program,
        ]);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        Object.defineProperty(process, 'platform', platformDescriptor);
    });

    async function createBlazorManagedConfiguration(dotNetConfig: object = {}): Promise<vscode.DebugConfiguration> {
        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        await provider.resolveDebugConfiguration(undefined, {
            name: 'Browser App',
            type: 'blazorwasm',
            request: 'launch',
            projectPath: path.join(workspacePath, 'App.csproj'),
            cwd: workspacePath,
            browser: 'chrome',
            url: 'http://localhost:5000',
            dotNetConfig,
        });
        const managed = jest.mocked(vscode.debug.startDebugging).mock.calls[0]?.[1];
        if (typeof managed !== 'object') {
            throw new Error('Blazor did not start a managed debug configuration.');
        }
        return managed;
    }
    test('Havit baseline trace reaches the browser configuration without enabling proxy protocol trace', async () => {
        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        const browser = await provider.resolveDebugConfiguration(undefined, {
            name: 'Havit URL helper',
            type: 'blazorwasm',
            request: 'attach',
            projectPath: path.join(workspacePath, 'App.csproj'),
            cwd: workspacePath,
            browser: 'edge',
            url: 'http://127.0.0.1:8001/components/HxGrid',
            trace: true,
            browserConfig: { runtimeExecutable: '/explicit/edge' },
            dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
        });
        expect(browser?.type).toBe('msedge');
        expect(browser?.trace).toBe(true);
        expect(browser?.runtimeExecutable).toBe('/explicit/edge');
        expect(jest.mocked(cp.spawn).mock.calls[0][1]).not.toContain('--DevToolsProxyLogging');
        expect(jest.mocked(cp.spawn).mock.calls[0][2]?.env?.WASMDBG_LOGGING).toBeUndefined();
    });
    test('explicit prototype host uses the configured dotnet without acquisition and scopes logs to proxy', async () => {
        const oldDotnet = process.env.VSCODE_CSHARP_WASMDBG_DOTNET;
        const oldArtifacts = process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR;
        try {
            process.env.VSCODE_CSHARP_WASMDBG_DOTNET = __filename;
            process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR = path.join(workspacePath, 'run', 'proxy-logs');
            await createBlazorManagedConfiguration();
            const [command, , options] = jest.mocked(cp.spawn).mock.calls[0];
            expect(command).toBe(__filename);
            expect(options?.env?.WASMDBG_ARTIFACT_DIR).toBe(process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR);
            expect(options?.detached).toBe(false);
            expect(
                jest
                    .mocked(vscode.commands.executeCommand)
                    .mock.calls.some(([name]) => ['dotnet.findPath', 'dotnet.acquire'].includes(name))
            ).toBe(false);
        } finally {
            if (oldDotnet === undefined) {
                delete process.env.VSCODE_CSHARP_WASMDBG_DOTNET;
            } else {
                process.env.VSCODE_CSHARP_WASMDBG_DOTNET = oldDotnet;
            }
            if (oldArtifacts === undefined) {
                delete process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR;
            } else {
                process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR = oldArtifacts;
            }
        }
    });

    test('invalid explicit prototype dotnet fails instead of acquiring or silently using another host', async () => {
        const old = process.env.VSCODE_CSHARP_WASMDBG_DOTNET;
        try {
            process.env.VSCODE_CSHARP_WASMDBG_DOTNET = 'relative-host';
            await expect(createBlazorManagedConfiguration()).rejects.toThrow('absolute native');
            expect(jest.mocked(cp.spawn)).not.toHaveBeenCalled();
        } finally {
            if (old === undefined) {
                delete process.env.VSCODE_CSHARP_WASMDBG_DOTNET;
            } else {
                process.env.VSCODE_CSHARP_WASMDBG_DOTNET = old;
            }
        }
    });
    test('Blazor preserves caller assets and options while enforcing browser connection defaults', async () => {
        const callerOptions = Object.freeze({
            assetsPath,
            ip: 'other-host',
            port: 1234,
            platform: 'android',
            isServer: false,
            customOption: 'retained',
        });
        const configuration = await createBlazorManagedConfiguration({
            program,
            coreClrMobileDebuggerOptions: callerOptions,
        });
        const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
            folder,
            configuration
        );

        expect(resolved?.type).toBe('coreclr_wasm');
        expect(resolved?.program).toBe(program);
        expect(resolved?.debugServer).toBeUndefined();
        expect(resolved?.coreClrMobileDebuggerOptions).toEqual({
            ...callerOptions,
            ip: '127.0.0.1',
            port: 6001,
            platform: 'browser;x64',
            isServer: true,
        });
        expect(workspaceProvider.getNet9WasmAssetsPathAndProgram).not.toHaveBeenCalled();
        expect(callerOptions.platform).toBe('android');
    });

    test('Blazor infers missing assets and program for the generated browser;x64 child', async () => {
        const configuration = await createBlazorManagedConfiguration();
        const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
            folder,
            configuration
        );

        expect(resolved?.coreClrMobileDebuggerOptions).toEqual({
            ip: '127.0.0.1',
            port: 6001,
            platform: 'browser;x64',
            isServer: true,
            assetsPath: path.dirname(program),
        });
        expect(resolved?.program).toBe(program);
        expect(workspaceProvider.getNet9WasmAssetsPathAndProgram).toHaveBeenCalledWith(folder);
    });

    test.each(['browser', 'browser;x64', 'x64;browser'])(
        'Direct CoreCLR configuration infers assets for platform %s',
        async (platform) => {
            const configuration: vscode.DebugConfiguration = {
                name: 'Direct CoreCLR',
                type: 'coreclr_wasm',
                request: 'launch',
                coreClrMobileDebuggerOptions: { platform },
            };
            const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
                folder,
                configuration
            );

            expect(resolved?.coreClrMobileDebuggerOptions).toEqual({ platform, assetsPath: path.dirname(program) });
            expect(resolved?.program).toBe(program);
            expect(resolved?.debugServer).toBeUndefined();
        }
    );

    test('prototype adapter port requires opt-in and preserves an explicit caller port', async () => {
        const previous = process.env.VSCODE_CSHARP_WASMDBG_CONCORD;
        try {
            process.env.VSCODE_CSHARP_WASMDBG_CONCORD = workspacePath;
            expect((await createBlazorManagedConfiguration()).debugServer).toBe(4711);
            const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(folder, {
                name: 'Direct CoreCLR',
                type: 'coreclr_wasm',
                request: 'launch',
                debugServer: 4921,
                program,
                coreClrMobileDebuggerOptions: { platform: 'browser;x64', assetsPath },
            });
            expect(resolved?.debugServer).toBe(4921);
        } finally {
            if (previous === undefined) {
                delete process.env.VSCODE_CSHARP_WASMDBG_CONCORD;
            } else {
                process.env.VSCODE_CSHARP_WASMDBG_CONCORD = previous;
            }
        }
    });

    test('Direct CoreCLR configuration preserves explicit host assets and program', async () => {
        const configuration: vscode.DebugConfiguration = {
            name: 'Direct CoreCLR',
            type: 'coreclr_wasm',
            request: 'launch',
            program,
            coreClrMobileDebuggerOptions: { platform: 'browser;x64', assetsPath },
        };
        const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
            folder,
            configuration
        );

        expect(resolved?.coreClrMobileDebuggerOptions.assetsPath).toBe(assetsPath);
        expect(resolved?.program).toBe(program);
        expect(workspaceProvider.getNet9WasmAssetsPathAndProgram).not.toHaveBeenCalled();
    });

    test.each(['android;x64', 'notbrowser;x64', '', undefined])(
        'Direct CoreCLR configuration does not treat platform %s as browser',
        async (platform) => {
            const configuration: vscode.DebugConfiguration = {
                name: 'Other platform',
                type: 'coreclr_wasm',
                request: 'launch',
                coreClrMobileDebuggerOptions: { platform },
            };
            const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
                folder,
                configuration
            );

            expect(resolved?.debugServer).toBeUndefined();
            expect(resolved?.coreClrMobileDebuggerOptions.assetsPath).toBeUndefined();
            expect(workspaceProvider.getNet9WasmAssetsPathAndProgram).not.toHaveBeenCalled();
        }
    );

    test.each(['browser', 'browser;x64'])(
        'Mono configuration converts platform %s to CoreCLR without duplicating architecture',
        async (platform) => {
            const configuration: vscode.DebugConfiguration = {
                name: 'Converted CoreCLR',
                type: 'monovsdbg_wasm',
                request: 'launch',
                program,
                monoDebuggerOptions: { platform, assetsPath },
            };
            const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
                folder,
                configuration
            );

            expect(resolved?.type).toBe('coreclr_wasm');
            expect(resolved?.monoDebuggerOptions).toBeUndefined();
            expect(resolved?.coreClrMobileDebuggerOptions).toEqual({ platform: 'browser;x64', assetsPath });
        }
    );

    test('Mono browser configuration remains Mono when the project does not select CoreCLR', async () => {
        jest.mocked(BlazorDebugConfigurationProvider.isCoreClrRuntime).mockResolvedValue(false);
        const configuration: vscode.DebugConfiguration = {
            name: 'Mono browser',
            type: 'monovsdbg_wasm',
            request: 'launch',
            monoDebuggerOptions: { platform: 'browser' },
        };
        const resolved = await workspaceProvider.resolveDebugConfigurationWithSubstitutedVariables(
            folder,
            configuration
        );

        expect(resolved?.type).toBe('monovsdbg_wasm');
        expect(resolved?.coreClrMobileDebuggerOptions).toBeUndefined();
        expect(resolved?.monoDebuggerOptions).toEqual({ platform: 'browser', assetsPath: path.dirname(program) });
        expect(resolved?.program).toBe(program);
    });

    describe('Windows CoreCLR hosted attach', () => {
        const clientProject = path.join(workspacePath, 'client', 'Client.csproj');
        const clientProgram = path.join(workspacePath, 'client', 'custom-output', 'Client.dll');
        const serverDirectory = path.join(workspacePath, 'server');
        const relay = 'ws://127.0.0.1:45678/ws-proxy?browser={browserInspectUri}';
        let nativeFailure: string | undefined;
        let onEvent: Parameters<typeof vscode.debug.onDidReceiveDebugSessionCustomEvent>[0] | undefined;
        let onTerminate: Parameters<typeof vscode.debug.onDidTerminateDebugSession>[0] | undefined;
        let keepManagedPending: boolean;
        let finishManaged: (() => void) | undefined;
        let managedSession: vscode.DebugSession;
        const client: ProjectDebugInformation = {
            projectPath: clientProject,
            outputPath: clientProgram,
            projectName: 'Client',
            solutionPath: null,
            targetsDotnetCore: true,
            isExe: true,
            isWebProject: false,
            isWebAssemblyProject: true,
            isBlazorWebAssemblyHosted: false,
            isBlazorWebAssemblyStandalone: true,
        };
        const projects = {
            getWorkspaceDebugInformation: jest.fn(async () => [
                { ...client, projectPath: path.join(serverDirectory, 'Server.csproj'), outputPath: program },
                client,
            ]),
        };
        const configuration: vscode.DebugConfiguration = {
            name: 'Hosted client',
            type: 'blazorwasm',
            request: 'attach',
            projectPath: clientProject,
            cwd: serverDirectory,
            hosted: true,
            browser: 'edge',
            url: 'http://localhost:5000',
            inspectUri:
                '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}',
        };

        beforeEach(() => {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            jest.spyOn(browserBridge, 'findBrowserDebugPort').mockResolvedValue(6002);
            nativeFailure = undefined;
            onEvent = undefined;
            onTerminate = undefined;
            keepManagedPending = false;
            finishManaged = undefined;
            jest.mocked(vscode.debug.onDidTerminateDebugSession).mockImplementation((listener) => {
                onTerminate = listener;
                return { dispose: jest.fn() };
            });
            jest.mocked(vscode.debug.onDidReceiveDebugSessionCustomEvent).mockImplementation((listener) => {
                onEvent = listener;
                return { dispose: jest.fn() };
            });
            jest.mocked(vscode.debug.startDebugging).mockImplementation(async (_, config) => {
                if (typeof config !== 'object') {
                    throw new Error('Expected managed configuration.');
                }
                managedSession = {
                    id: 'owned-native-session',
                    name: config.name,
                    type: config.type,
                    configuration: config,
                    workspaceFolder: folder,
                    parentSession: undefined,
                    customRequest: async () => undefined,
                    getDebugProtocolBreakpoint: async () => undefined,
                };
                onEvent?.({
                    session: managedSession,
                    event: 'dotnet/browserBridgeReady',
                    body: { token: 'unrelated', success: false, error: 'Must be ignored.' },
                });
                onEvent?.({
                    session: managedSession,
                    event: 'dotnet/browserBridgeReady',
                    body: {
                        token: config.remoteBrowserBridge.token,
                        success: nativeFailure === undefined,
                        error: nativeFailure,
                        browserPort: 6002,
                        inspectUri: relay,
                    },
                });
                if (keepManagedPending) {
                    await new Promise<void>((resolve) => {
                        finishManaged = resolve;
                    });
                }
                return true;
            });
        });

        test('resolves exact client output without dotNetConfig and replaces the legacy relay', async () => {
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            const browser = await provider.resolveDebugConfiguration(folder, configuration);
            const managed = managedSession.configuration;
            expect(managed.justMyCode).toBe(true);
            expect(managed.program).toBe(clientProgram);
            expect(managed.cwd).toBe(path.dirname(clientProject));
            expect(managed.args).toEqual([]);
            expect(managed.coreClrMobileDebuggerOptions).toMatchObject({
                assetsPath: path.dirname(clientProgram),
                ip: '127.0.0.1',
                port: 6002,
                isServer: false,
            });
            expect(browser).toMatchObject({ type: 'msedge', port: 6002, inspectUri: relay });
            expect(cp.spawn).not.toHaveBeenCalled();
        });

        test.each([true, false])('preserves explicit Just My Code: %s', async (justMyCode) => {
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            await provider.resolveDebugConfiguration(folder, {
                ...configuration,
                dotNetConfig: { justMyCode },
            });
            expect(managedSession.configuration.justMyCode).toBe(justMyCode);
        });

        test('preserves explicit client program and avoids a workspace query', async () => {
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            await provider.resolveDebugConfiguration(folder, {
                ...configuration,
                dotNetConfig: { program: clientProgram },
            });
            expect(managedSession.configuration.program).toBe(clientProgram);
            expect(projects.getWorkspaceDebugInformation).not.toHaveBeenCalled();
        });

        test('native failure stops only the token-correlated initializing managed session', async () => {
            nativeFailure = 'Native startup failed.';
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            await expect(provider.resolveDebugConfiguration(folder, configuration)).rejects.toThrow(nativeFailure);
            expect(vscode.debug.stopDebugging).toHaveBeenCalledTimes(1);
            expect(vscode.debug.stopDebugging).toHaveBeenCalledWith(managedSession);
            expect(cp.spawn).not.toHaveBeenCalled();
        });

        test('cancelled project resolution does not start a managed session or browser', async () => {
            const token: vscode.CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: jest.fn() }),
            };
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            await expect(provider.resolveDebugConfiguration(folder, configuration, token)).rejects.toThrow('Canceled');
            expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
            expect(cp.spawn).not.toHaveBeenCalled();
        });

        test('cancellation after native readiness still stops the initializing managed session', async () => {
            keepManagedPending = true;
            let cancel: (() => void) | undefined;
            const token: vscode.CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: (listener) => {
                    cancel = () => listener(undefined);
                    return { dispose: jest.fn() };
                },
            };
            const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
            try {
                await provider.resolveDebugConfiguration(folder, configuration, token);
                cancel?.();
                expect(vscode.debug.stopDebugging).toHaveBeenCalledTimes(1);
                expect(vscode.debug.stopDebugging).toHaveBeenCalledWith(managedSession);
            } finally {
                finishManaged?.();
            }
        });

        test.each([true, false])(
            'only its own failed browser startup stops managed launch: owned=%s',
            async (owned) => {
                keepManagedPending = true;
                const provider = new BlazorDebugConfigurationProvider(logger, vscode, projects);
                try {
                    const browser = await provider.resolveDebugConfiguration(folder, configuration);
                    if (!browser) {
                        throw new Error('Expected native browser configuration.');
                    }
                    onTerminate?.({
                        ...managedSession,
                        id: 'browser-session',
                        type: 'msedge',
                        configuration: { ...browser, inspectUri: owned ? relay : 'ws://127.0.0.1:11111/unrelated' },
                    });
                    expect(vscode.debug.stopDebugging).toHaveBeenCalledTimes(owned ? 1 : 0);
                    if (owned) {
                        expect(vscode.debug.stopDebugging).toHaveBeenCalledWith(managedSession);
                    }
                } finally {
                    finishManaged?.();
                }
            }
        );
    });
});
