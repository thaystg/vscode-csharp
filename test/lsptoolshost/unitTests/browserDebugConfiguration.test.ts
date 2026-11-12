/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as net from 'net';
import { BlazorDebugConfigurationProvider } from '../../../src/razor/src/blazorDebug/blazorDebugConfigurationProvider';
import { BaseVsDbgConfigurationProvider } from '../../../src/shared/configurationProvider';
import { PlatformInformation } from '../../../src/shared/platform';
import { setExtensionPath } from '../../../src/common';
import { getNullChannel } from '../../fakes';

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
        debug: {
            startDebugging: jest.fn(async () => true),
            stopDebugging: jest.fn(async () => undefined),
            onDidStartDebugSession: jest.fn(() => ({ dispose: jest.fn() })),
            onDidTerminateDebugSession: jest.fn(() => ({ dispose: jest.fn() })),
            onDidReceiveDebugSessionCustomEvent: jest.fn(() => ({ dispose: jest.fn() })),
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
    const workspacePath = path.resolve('testWorkspace');
    const program = path.join(workspacePath, 'bin', 'App.dll');
    const assetsPath = path.join(workspacePath, 'wwwroot', '_framework');
    const folder: vscode.WorkspaceFolder = { name: 'App', uri: vscode.Uri.file(workspacePath), index: 0 };
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
        setExtensionPath(workspacePath);
        jest.spyOn(BlazorDebugConfigurationProvider, 'isCoreClrRuntime').mockResolvedValue(true);
        workspaceProvider = new BaseVsDbgConfigurationProvider(new PlatformInformation('darwin', 'arm64'), logger);
        jest.spyOn(workspaceProvider, 'isDotnetWorkspaceConfigurationProvider').mockReturnValue(true);
        jest.spyOn(workspaceProvider, 'getNet9WasmAssetsPathAndProgram').mockResolvedValue([
            path.dirname(program),
            program,
        ]);
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

    function publishNativeBridgeEvent(event: string, body: object, configuration: vscode.DebugConfiguration): void {
        const session = {
            id: 'native-session',
            name: configuration.name,
            type: configuration.type,
            configuration,
        } as vscode.DebugSession;
        for (const [listener] of jest.mocked(vscode.debug.onDidStartDebugSession).mock.calls) {
            listener(session);
        }
        for (const [listener] of jest.mocked(vscode.debug.onDidReceiveDebugSessionCustomEvent).mock.calls) {
            listener({ session, event, body });
        }
    }

    test('native bridge starts Concord before js-debug and never launches BrowserDebugHost', async () => {
        let managedConfiguration: vscode.DebugConfiguration | undefined;
        jest.mocked(vscode.debug.startDebugging).mockImplementation(async (_folder, configuration) => {
            if (typeof configuration !== 'string' && configuration.remoteBrowserBridge) {
                managedConfiguration = configuration;
                queueMicrotask(() => {
                    publishNativeBridgeEvent(
                        'dotnet/browserBridgeReady',
                        {
                            token: configuration.remoteBrowserBridge.token,
                            success: true,
                            browserPort: 6200,
                            inspectUri: 'ws://127.0.0.1:6300/{browserInspectUriPath}',
                        },
                        configuration
                    );
                });
            }
            return true;
        });

        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        const browser = await provider.resolveDebugConfiguration(undefined, {
            name: 'Native browser app',
            type: 'blazorwasm',
            request: 'attach',
            projectPath: path.join(workspacePath, 'App.csproj'),
            cwd: workspacePath,
            browser: 'chrome',
            url: 'http://localhost:5000',
            nativeBrowserBridge: { enabled: true, browserPort: 6200 },
            dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
        });

        expect(cp.spawn).not.toHaveBeenCalled();
        expect(managedConfiguration?.remoteBrowserBridge).toEqual({
            token: expect.any(String),
            browserPort: 6200,
            appUrl: 'http://localhost:5000',
        });
        expect(managedConfiguration?.coreClrMobileDebuggerOptions).toEqual({
            assetsPath,
            ip: '127.0.0.1',
            port: 6200,
            platform: 'browser;x64',
            isServer: false,
        });
        expect(browser).toMatchObject({
            type: 'chrome',
            port: 6200,
            inspectUri: 'ws://127.0.0.1:6300/{browserInspectUriPath}',
        });
        expect(jest.mocked(vscode.debug.startDebugging).mock.calls[0][1]).toBe(managedConfiguration);
    });

    test('remote DBI-owned native bridge launches js-debug without external readiness', async () => {
        let managedConfiguration: vscode.DebugConfiguration | undefined;
        jest.mocked(vscode.debug.startDebugging).mockImplementation(async (_folder, configuration) => {
            if (typeof configuration !== 'string' && configuration.type === 'coreclr_wasm') {
                managedConfiguration = configuration;
            }
            return true;
        });
        const relay = net.createServer();
        await new Promise<void>((resolve, reject) => {
            relay.once('error', reject);
            relay.listen({ host: '127.0.0.1', port: 6206, exclusive: true }, resolve);
        });

        try {
            const provider = new BlazorDebugConfigurationProvider(logger, vscode);
            const browser = await provider.resolveDebugConfiguration(undefined, {
                name: 'Remote DBI-owned native browser app',
                type: 'blazorwasm',
                request: 'attach',
                projectPath: path.join(workspacePath, 'App.csproj'),
                cwd: workspacePath,
                browser: 'chrome',
                url: 'http://localhost:5000',
                nativeBrowserBridge: { enabled: true, remoteDbiOwned: true, browserPort: 6205 },
                dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
            });

            expect(cp.spawn).not.toHaveBeenCalled();
            expect(managedConfiguration?.remoteBrowserBridge).toBeUndefined();
            expect(managedConfiguration?.localMetadataPreloadToken).toBeUndefined();
            expect(managedConfiguration?.coreClrMobileDebuggerOptions).toEqual({
                assetsPath,
                ip: '127.0.0.1',
                port: 6205,
                platform: 'browser;x64',
                isServer: false,
            });
            expect(browser).toMatchObject({
                type: 'chrome',
                port: 6205,
                inspectUri: 'ws://127.0.0.1:6206/ws-proxy?browser={browserInspectUri}',
            });
        } finally {
            await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
        }
    });

    test('remote DBI-owned native bridge rejects a browser port without an adjacent relay port', async () => {
        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        await expect(
            provider.resolveDebugConfiguration(undefined, {
                name: 'Remote DBI-owned native browser app',
                type: 'blazorwasm',
                request: 'attach',
                projectPath: path.join(workspacePath, 'App.csproj'),
                cwd: workspacePath,
                browser: 'chrome',
                url: 'http://localhost:5000',
                nativeBrowserBridge: { enabled: true, remoteDbiOwned: true, browserPort: 65535 },
                dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
            })
        ).rejects.toThrow('adjacent relay port');
    });

    test('native bridge waits for required local metadata before launching js-debug', async () => {
        let managedConfiguration: vscode.DebugConfiguration | undefined;
        let publishMetadata: (() => void) | undefined;
        jest.mocked(vscode.debug.startDebugging).mockImplementation(async (_folder, configuration) => {
            if (typeof configuration !== 'string' && configuration.remoteBrowserBridge) {
                managedConfiguration = configuration;
                queueMicrotask(() => {
                    publishNativeBridgeEvent(
                        'dotnet/browserBridgeReady',
                        {
                            token: configuration.remoteBrowserBridge.token,
                            success: true,
                            browserPort: 6201,
                            inspectUri: 'ws://127.0.0.1:6301/{browserInspectUriPath}',
                        },
                        configuration
                    );
                    publishMetadata = () =>
                        publishNativeBridgeEvent(
                            'dotnet/localMetadataReady',
                            {
                                token: configuration.localMetadataPreloadToken,
                                success: true,
                                metadataCount: 12,
                            },
                            configuration
                        );
                });
            }
            return true;
        });

        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        let settled = false;
        const result = provider
            .resolveDebugConfiguration(undefined, {
                name: 'Native metadata app',
                type: 'blazorwasm',
                request: 'attach',
                projectPath: path.join(workspacePath, 'App.csproj'),
                url: 'http://localhost:5000',
                nativeBrowserBridge: {
                    enabled: true,
                    browserPort: 6201,
                    preloadLocalMetadata: true,
                },
                dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
            })
            .then((value) => {
                settled = true;
                return value;
            });
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(managedConfiguration?.localMetadataPreloadToken).toEqual(expect.any(String));

        publishMetadata?.();
        await expect(result).resolves.toMatchObject({ port: 6201 });
    });

    test('native bridge failure is propagated without managed fallback', async () => {
        jest.mocked(vscode.debug.startDebugging).mockImplementation(async (_folder, configuration) => {
            if (typeof configuration !== 'string' && configuration.remoteBrowserBridge) {
                queueMicrotask(() => {
                    publishNativeBridgeEvent(
                        'dotnet/browserBridgeReady',
                        {
                            token: configuration.remoteBrowserBridge.token,
                            success: false,
                            error: 'native preparation failed',
                        },
                        configuration
                    );
                });
            }
            return true;
        });

        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        await expect(
            provider.resolveDebugConfiguration(undefined, {
                name: 'Native failure',
                type: 'blazorwasm',
                request: 'attach',
                projectPath: path.join(workspacePath, 'App.csproj'),
                nativeBrowserBridge: { enabled: true, browserPort: 6202 },
                dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
            })
        ).rejects.toThrow('native preparation failed');
        expect(cp.spawn).not.toHaveBeenCalled();
    });

    test('native bridge cancellation rejects and does not launch BrowserDebugHost', async () => {
        let cancel: (() => void) | undefined;
        const cancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: (
                listener: () => void,
                _thisArgs?: unknown,
                _disposables?: vscode.Disposable[]
            ) => {
                cancel = listener;
                return { dispose: jest.fn() };
            },
        } as unknown as vscode.CancellationToken;
        jest.mocked(vscode.debug.startDebugging).mockImplementation(async () => {
            queueMicrotask(() => cancel?.());
            return true;
        });

        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        await expect(
            provider.resolveDebugConfiguration(
                undefined,
                {
                    name: 'Native cancellation',
                    type: 'blazorwasm',
                    request: 'attach',
                    projectPath: path.join(workspacePath, 'App.csproj'),
                    nativeBrowserBridge: { enabled: true, browserPort: 6203 },
                    dotNetConfig: { program, coreClrMobileDebuggerOptions: { assetsPath } },
                },
                cancellationToken
            )
        ).rejects.toThrow('was canceled');
        expect(cp.spawn).not.toHaveBeenCalled();
    });

    test('native bridge opt-in is rejected for Mono without falling back', async () => {
        jest.mocked(BlazorDebugConfigurationProvider.isCoreClrRuntime).mockResolvedValue(false);
        const provider = new BlazorDebugConfigurationProvider(logger, vscode);
        await expect(
            provider.resolveDebugConfiguration(undefined, {
                name: 'Mono native bridge',
                type: 'blazorwasm',
                request: 'attach',
                projectPath: path.join(workspacePath, 'App.csproj'),
                nativeBrowserBridge: { enabled: true, browserPort: 6204 },
            })
        ).rejects.toThrow('supported only for CoreCLR');
        expect(cp.spawn).not.toHaveBeenCalled();
    });

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
        expect(resolved?.debugServer).toBe(4711);
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
            expect(resolved?.debugServer).toBe(4711);
        }
    );

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
});
