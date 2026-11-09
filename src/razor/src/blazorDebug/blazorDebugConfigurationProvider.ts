/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import * as net from 'net';
import * as vscode from 'vscode';
import { ChromeBrowserFinder, EdgeBrowserFinder } from '@vscode/js-debug-browsers';
import { ONLY_JS_DEBUG_NAME, MANAGED_DEBUG_NAME, JS_DEBUG_NAME, SERVER_APP_NAME } from './constants';
import { isValidEvent, onDidTerminateDebugSession } from './terminateDebugHandler';
import path = require('path');
import * as cp from 'child_process';
import { getExtensionPath } from '../../../common';
import { getCSharpDevKit } from '../../../utils/getCSharpDevKit';
import { CSharpExtensionId } from '../../../constants/csharpExtensionId';
import { DotNetRuntimeVersion } from '../../../lsptoolshost/dotnetRuntime/dotnetRuntimeExtensionResolver';
import {
    IDotnetAcquireContext,
    IDotnetAcquireResult,
    IDotnetFindPathContext,
} from '../../../lsptoolshost/dotnetRuntime/dotnetRuntimeExtensionApi';
import { IDisposable } from '@microsoft/servicehub-framework';
import { Observer } from '@microsoft/servicehub-framework/js/src/jsonRpc/Observer';
import { EventEmitter } from 'events';
import {
    Formatters,
    MessageDelimiters,
    ServiceJsonRpcDescriptor,
    ServiceMoniker,
    ServiceRpcDescriptor,
} from '@microsoft/servicehub-framework';

interface IDebugTargetFrameworkService {
    subscribe(observer: Observer<ProjectDebugTargetFrameworkInfo[]>): Promise<IDisposable>;
}

interface ProjectDebugTargetFrameworkInfo {
    fullPath: string;
    debugTargetFramework: string | undefined;
    availableTargetFrameworks: FrameworkInfo[];
}

interface FrameworkInfo {
    framework: string;
    displayName: string;
}

interface NativeBrowserBridgeOptions {
    enabled?: boolean;
    browserPort?: number;
    targetId?: string;
    preloadLocalMetadata?: boolean;
    readinessTimeout?: number;
}

interface NativeBrowserBridgeReadyBody {
    token?: string;
    success?: boolean;
    error?: string;
    browserPort?: number;
    inspectUri?: string;
}

interface ManagedBrowserDebugConfiguration {
    app: vscode.DebugConfiguration;
    inspectUri: string;
    portBrowserDebug: number;
    nativeBridgeReadiness?: Promise<{ inspectUri: string; browserPort: number }>;
}

const targetFrameworkServiceDescriptor: ServiceRpcDescriptor = Object.freeze(
    new ServiceJsonRpcDescriptor(
        ServiceMoniker.create('Microsoft.VisualStudio.ProjectSystem.DebugTargetFrameworkService', '0.1'),
        Formatters.Utf8,
        MessageDelimiters.HttpLikeHeaders,
        {
            protocolMajorVersion: 3,
        }
    )
);

import { showErrorMessage, showInformationMessage } from '../../../shared/observers/utils/showMessage';

export class BlazorDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private static readonly autoDetectUserNotice: string = vscode.l10n.t(
        'Run and Debug: auto-detection found {0} for a launch browser'
    );
    private static readonly edgeBrowserType: string = 'msedge';
    private static readonly chromeBrowserType: string = 'chrome';
    private static readonly pidsByUrl = new Map<string, number | undefined>();
    private static readonly vsWebAssemblyBridgeOutputChannel = vscode.window.createOutputChannel('VsWebAssemblyBridge');

    // Session tracking: captures sessions started during a Blazor debug launch
    // so they can all be torn down together when any one terminates.
    // Static because tryToUseVSDbgForMono (called by C# Dev Kit) is static.
    private static isTrackingSessions = false;
    private static readonly trackedSessionIds = new Set<string>();
    private static readonly trackedSessionsById = new Map<string, vscode.DebugSession>();

    constructor(
        private readonly logger: vscode.LogOutputChannel,
        private readonly vscodeType: typeof vscode
    ) {}

    public static register(logger: vscode.LogOutputChannel, vscodeType: typeof vscode) {
        const provider = new BlazorDebugConfigurationProvider(logger, vscodeType);
        const disposables: vscode.Disposable[] = [];

        disposables.push(vscodeType.debug.registerDebugConfigurationProvider('blazorwasm', provider));

        // Track sessions started during our Blazor launch sequence.
        disposables.push(
            vscodeType.debug.onDidStartDebugSession((session) => {
                if (BlazorDebugConfigurationProvider.isTrackingSessions) {
                    BlazorDebugConfigurationProvider.trackedSessionIds.add(session.id);
                    BlazorDebugConfigurationProvider.trackedSessionsById.set(session.id, session);
                }
            })
        );

        // When any tracked session terminates, stop all remaining siblings.
        disposables.push(
            vscodeType.debug.onDidTerminateDebugSession(async (event) => {
                if (!BlazorDebugConfigurationProvider.trackedSessionIds.has(event.id)) {
                    return;
                }
                BlazorDebugConfigurationProvider.isTrackingSessions = false;
                BlazorDebugConfigurationProvider.trackedSessionIds.delete(event.id);
                BlazorDebugConfigurationProvider.trackedSessionsById.delete(event.id);
                const sessionsToStop = [...BlazorDebugConfigurationProvider.trackedSessionsById.values()];
                BlazorDebugConfigurationProvider.trackedSessionIds.clear();
                BlazorDebugConfigurationProvider.trackedSessionsById.clear();
                for (const session of sessionsToStop) {
                    await vscodeType.debug.stopDebugging(session);
                }
            })
        );

        return vscode.Disposable.from(...disposables);
    }

    public async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration,
        cancellationToken?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined> {
        const debugFolder = BlazorDebugConfigurationProvider.resolveDebugFolder(folder, configuration);
        this.logger.info(
            `[DEBUGGER] Blazor debug folder: ${BlazorDebugConfigurationProvider.formatFolder(debugFolder)}`
        );
        this.logger.info(
            `[DEBUGGER] Blazor final debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                configuration
            )}`
        );

        // Enable session tracking so that onDidStartDebugSession captures
        // every session launched as part of this Blazor debug sequence.
        // Tracking stays on until the first tracked session terminates,
        // because sessions may start asynchronously after startDebugging resolves.
        BlazorDebugConfigurationProvider.trackedSessionIds.clear();
        BlazorDebugConfigurationProvider.trackedSessionsById.clear();
        BlazorDebugConfigurationProvider.isTrackingSessions = true;

        const debugConfigurations: vscode.DebugConfiguration[] = [];

        /**
         * The Blazor WebAssembly app should only be launched if the
         * launch configuration is a launch request. Attach requests will
         * only launch the browser.
         */
        if (configuration.request === 'launch') {
            const app = this.createAppDebugConfiguration(debugFolder, configuration);
            debugConfigurations.push(app);
        }

        let inspectUri =
            '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}';
        let url = 'https://localhost:5001';
        try {
            if (debugFolder !== undefined) {
                let folderPath = configuration.cwd ? configuration.cwd : fileURLToPath(debugFolder.uri.toString());
                folderPath = folderPath.replace('${workspaceFolder}', fileURLToPath(debugFolder.uri.toString()));
                const launchSettings = JSON.parse(
                    readFileSync(join(folderPath, 'Properties', 'launchSettings.json'), 'utf8')
                );
                if (
                    launchSettings?.profiles &&
                    launchSettings?.profiles[Object.keys(launchSettings.profiles)[0]]?.inspectUri
                ) {
                    inspectUri = launchSettings.profiles[Object.keys(launchSettings.profiles)[0]].inspectUri;
                    url = launchSettings.profiles[Object.keys(launchSettings.profiles)[0]].applicationUrl.split(
                        ';',
                        1
                    )[0];
                }
            }
        } catch (error: any) {
            this.logger.error('[DEBUGGER] Error while getting information from launchSettings.json: ', error as Error);
        }

        if (BlazorDebugConfigurationProvider.shouldLaunchBrowser(configuration)) {
            const browserConfigurations = await this.createBrowserDebugConfigurations(
                debugFolder,
                configuration,
                inspectUri,
                url,
                cancellationToken
            );
            debugConfigurations.push(...browserConfigurations);
        }

        if (debugConfigurations.length === 0) {
            return undefined;
        }

        this.registerAdditionalDebugConfigurations(debugConfigurations);

        return debugConfigurations[0];
    }

    private createAppDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration
    ): vscode.DebugConfiguration {
        const program = configuration.hosted ? configuration.program : 'dotnet';
        const cwd = configuration.cwd || '${workspaceFolder}';
        const args = configuration.hosted ? [] : ['run'];

        const app: vscode.DebugConfiguration = {
            name: SERVER_APP_NAME,
            type: 'coreclr',
            request: 'launch',
            prelaunchTask: 'build',
            program,
            args,
            cwd,
            env: {
                ASPNETCORE_ENVIRONMENT: 'Development',
                DOTNET_MODIFIABLE_ASSEMBLIES: 'debug',
                ...configuration.env,
            },
            launchBrowser: {
                enabled: false,
            },
            cascadeTerminateToConfigurations: [ONLY_JS_DEBUG_NAME, MANAGED_DEBUG_NAME, JS_DEBUG_NAME],
            ...configuration.dotNetConfig,
        };

        this.logger.info(
            `[DEBUGGER] Blazor app debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                app
            )}`
        );
        this.registerNonWindowsAppTerminationHandler(folder, configuration, app);

        return app;
    }

    private registerAdditionalDebugConfigurations(debugConfigurations: vscode.DebugConfiguration[]) {
        if (debugConfigurations.length <= 1) {
            return;
        }

        let currentConfigurationIndex = 0;
        const startDebugEvent = this.vscodeType.debug.onDidStartDebugSession(async (debugSession) => {
            const currentConfiguration = debugConfigurations[currentConfigurationIndex];
            if (!BlazorDebugConfigurationProvider.isDebugSessionForConfiguration(debugSession, currentConfiguration)) {
                return;
            }

            currentConfigurationIndex++;
            const nextConfiguration = debugConfigurations[currentConfigurationIndex];
            if (!nextConfiguration) {
                startDebugEvent.dispose();
                return;
            }

            try {
                this.logger.info(
                    `[DEBUGGER] Starting Blazor child debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                        nextConfiguration
                    )}`
                );
                const didStart = await this.vscodeType.debug.startDebugging(
                    debugSession.workspaceFolder,
                    nextConfiguration,
                    debugSession
                );
                if (!didStart) {
                    startDebugEvent.dispose();
                    this.logger.warn(
                        `[DEBUGGER] Blazor child debug configuration did not start: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                            nextConfiguration
                        )}`
                    );
                }
            } catch (error) {
                startDebugEvent.dispose();
                this.logger.error('[DEBUGGER] Error when launching Blazor child debug configuration: ', error as Error);
            }
        });
    }

    private static isDebugSessionForConfiguration(
        debugSession: vscode.DebugSession,
        debugConfiguration: vscode.DebugConfiguration
    ): boolean {
        return debugSession.name === debugConfiguration.name && debugSession.type === debugConfiguration.type;
    }

    private registerNonWindowsAppTerminationHandler(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration,
        app: vscode.DebugConfiguration
    ) {
        if (process.platform === 'win32') {
            return;
        }

        const terminate = this.vscodeType.debug.onDidTerminateDebugSession(async (event) => {
            if (!isValidEvent(event.name)) {
                return;
            }
            const blazorDevServer = 'blazor-devserver\\.dll';
            const dir = folder && folder.uri && folder.uri.fsPath;
            if (!dir) {
                terminate.dispose();
                return;
            }

            const regexEscapedDir = dir.toLowerCase().replace(/\//g, '\\/');
            const launchedApp = configuration.hosted
                ? (app.program as string)
                : `${regexEscapedDir}.*${blazorDevServer}|${blazorDevServer}.*${regexEscapedDir}`;
            await onDidTerminateDebugSession(event, this.logger, launchedApp);
            terminate.dispose();
        });
    }

    private static shouldLaunchBrowser(configuration: vscode.DebugConfiguration): boolean {
        return configuration.launchBrowser !== false;
    }

    private async createBrowserDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration,
        inspectUri: string,
        url: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration[]> {
        const debugConfigurations: vscode.DebugConfiguration[] = [];
        const projectPath = BlazorDebugConfigurationProvider.resolveProjectPath(folder, configuration);
        const nativeBridge = configuration.nativeBrowserBridge as NativeBrowserBridgeOptions | undefined;
        const useVSDbg =
            nativeBridge?.enabled === true || (await BlazorDebugConfigurationProvider.useVSDbg(projectPath));
        let portBrowserDebug = -1;
        if (useVSDbg) {
            const managedDebugConfiguration = await this.createManagedDebugConfigurationOnBrowser(
                configuration,
                url,
                projectPath,
                cancellationToken
            );
            portBrowserDebug = managedDebugConfiguration.portBrowserDebug;
            const startManagedDebugging = async () => {
                this.logger.info(
                    `[DEBUGGER] Starting Blazor managed debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                        managedDebugConfiguration.app
                    )}`
                );
                const didStart = await this.vscodeType.debug.startDebugging(folder, managedDebugConfiguration.app);
                if (!didStart) {
                    throw new Error('The managed WebAssembly debug session did not start.');
                }
            };

            if (managedDebugConfiguration.nativeBridgeReadiness) {
                const startResult = startManagedDebugging().then(
                    async () => new Promise<never>(() => undefined),
                    async (error) => Promise.reject(error)
                );
                const ready = await Promise.race([managedDebugConfiguration.nativeBridgeReadiness, startResult]);
                inspectUri = ready.inspectUri;
                portBrowserDebug = ready.browserPort;
            } else if (managedDebugConfiguration.app.type === 'coreclr_wasm') {
                void startManagedDebugging().catch((error) => {
                    this.logger.error(
                        '[DEBUGGER] Error when launching Blazor managed debug configuration: ',
                        error as Error
                    );
                });
                inspectUri = managedDebugConfiguration.inspectUri;
            } else {
                await startManagedDebugging();
                inspectUri = managedDebugConfiguration.inspectUri;
            }
        }

        const configBrowser = configuration.browser;
        const browserType =
            configBrowser === 'edge'
                ? BlazorDebugConfigurationProvider.edgeBrowserType
                : configBrowser === 'chrome'
                  ? BlazorDebugConfigurationProvider.chromeBrowserType
                  : await BlazorDebugConfigurationProvider.determineBrowserType();
        if (!browserType) {
            return debugConfigurations;
        }

        const browser: vscode.DebugConfiguration = {
            ...configuration,
            name: configuration.name || (useVSDbg ? ONLY_JS_DEBUG_NAME : JS_DEBUG_NAME),
            type: browserType,
            request: 'launch',
            timeout: configuration.timeout || 30000,
            url: configuration.url || url,
            webRoot: configuration.webRoot || '${workspaceFolder}',
            inspectUri,
            trace: configuration.trace || false,
            noDebug: configuration.noDebug || false,
            ...configuration.browserConfig,
            // When the browser debugging session is stopped, propogate
            // this and terminate the debugging session of the Blazor dev server.
            cascadeTerminateToConfigurations: [SERVER_APP_NAME, MANAGED_DEBUG_NAME],
        };

        if (useVSDbg) {
            browser.port = portBrowserDebug;
        }

        this.logger.info(
            `[DEBUGGER] Blazor browser debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                browser
            )}`
        );
        debugConfigurations.push(browser);

        return debugConfigurations;
    }

    private static resolveProjectPath(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration
    ): string {
        const configuredProjectPath = configuration.projectPath as string | undefined;
        if (configuredProjectPath) {
            return BlazorDebugConfigurationProvider.resolveWorkspaceFolderToken(folder, configuredProjectPath);
        }

        const cwd = configuration.cwd as string | undefined;
        if (cwd) {
            return BlazorDebugConfigurationProvider.resolveWorkspaceFolderToken(folder, cwd);
        }

        return '';
    }

    private static resolveWorkspaceFolderToken(folder: vscode.WorkspaceFolder | undefined, value: string): string {
        if (folder) {
            value = value.replace('${workspaceFolder}', fileURLToPath(folder.uri.toString()));
        }

        return value.replaceAll(/[\\/]/g, path.sep);
    }

    private static resolveDebugFolder(
        folder: vscode.WorkspaceFolder | undefined,
        configuration: vscode.DebugConfiguration
    ): vscode.WorkspaceFolder | undefined {
        if (folder) {
            return folder;
        }

        const projectPath = configuration.projectPath as string | undefined;
        if (projectPath && !projectPath.includes('${workspaceFolder}')) {
            return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
        }

        const cwd = configuration.cwd as string | undefined;
        if (cwd && !cwd.includes('${workspaceFolder}')) {
            return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
        }

        return undefined;
    }

    private static formatFolder(folder: vscode.WorkspaceFolder | undefined): string {
        if (!folder) {
            return 'undefined';
        }

        return JSON.stringify({ name: folder.name, uri: folder.uri.toString(), fsPath: folder.uri.fsPath });
    }

    private static stringifyDebugConfiguration(configuration: vscode.DebugConfiguration): string {
        return JSON.stringify(
            configuration,
            (key, value) => {
                if (key === 'env' && value && typeof value === 'object') {
                    return '<redacted>';
                }

                if (/token|password|secret/i.test(key)) {
                    return '<redacted>';
                }

                return value;
            },
            2
        );
    }

    private async createManagedDebugConfigurationOnBrowser(
        configuration: vscode.DebugConfiguration,
        url: string,
        projectPath: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<ManagedBrowserDebugConfiguration> {
        const useCoreClr = await BlazorDebugConfigurationProvider.isCoreClrRuntime(projectPath);
        const nativeBridge = configuration.nativeBrowserBridge as NativeBrowserBridgeOptions | undefined;
        const useNativeBridge = nativeBridge?.enabled === true;
        if (useNativeBridge && !useCoreClr) {
            throw new Error('The native browser bridge is supported only for CoreCLR WebAssembly projects.');
        }

        let inspectUriRet = '';
        let portICorDebug = -1;
        let portBrowserDebug: number;
        let nativeBridgeReadiness: ManagedBrowserDebugConfiguration['nativeBridgeReadiness'];
        let remoteBrowserBridge: vscode.DebugConfiguration['remoteBrowserBridge'];
        let localMetadataPreloadToken: string | undefined;

        if (useNativeBridge) {
            portBrowserDebug =
                nativeBridge.browserPort ?? (await BlazorDebugConfigurationProvider.findAvailableBrowserPort());
            BlazorDebugConfigurationProvider.validateBrowserPort(portBrowserDebug);
            const token = randomBytes(24).toString('hex');
            remoteBrowserBridge = {
                token,
                browserPort: portBrowserDebug,
                appUrl: configuration.url || url,
                ...(nativeBridge.targetId !== undefined ? { targetId: nativeBridge.targetId } : {}),
            };
            if (nativeBridge.preloadLocalMetadata === true) {
                localMetadataPreloadToken = randomBytes(24).toString('hex');
            }
            nativeBridgeReadiness = this.waitForNativeBrowserBridge(
                token,
                localMetadataPreloadToken,
                portBrowserDebug,
                nativeBridge.readinessTimeout ?? configuration.timeout ?? 30000,
                cancellationToken
            );
        } else {
            [inspectUriRet, portICorDebug, portBrowserDebug] =
                await BlazorDebugConfigurationProvider.launchVsWebAssemblyBridge(configuration.url || url, useCoreClr);
        }

        const cwd = configuration.cwd || '${workspaceFolder}';
        const args = configuration.hosted ? [] : ['run'];
        const app: vscode.DebugConfiguration = {
            name: MANAGED_DEBUG_NAME,
            type: useCoreClr ? 'coreclr_wasm' : 'monovsdbg_wasm',
            request: 'launch',
            // TODO: temporary - remove before merging. Connects to a locally running
            // Concord debug adapter (debugServer) instead of spawning the packaged one.
            debugServer: 4711,
            args,
            cwd,
            cascadeTerminateToConfigurations: [ONLY_JS_DEBUG_NAME, SERVER_APP_NAME, JS_DEBUG_NAME],
            ...configuration.dotNetConfig,
            ...(remoteBrowserBridge ? { remoteBrowserBridge } : {}),
            ...(localMetadataPreloadToken ? { localMetadataPreloadToken } : {}),
        };

        const debuggerOptions = {
            ip: '127.0.0.1',
            port: useNativeBridge ? portBrowserDebug : portICorDebug,
            platform: useCoreClr ? 'browser;x64' : 'browser',
            isServer: !useNativeBridge,
        };
        if (useCoreClr) {
            app.coreClrMobileDebuggerOptions = {
                ...app.coreClrMobileDebuggerOptions,
                ...debuggerOptions,
            };
            if (typeof app.program === 'string') {
                const symbolOptions = app.symbolOptions ?? {};
                const searchPaths = symbolOptions.searchPaths ?? [];
                app.symbolOptions = {
                    ...symbolOptions,
                    searchPaths: [...searchPaths, path.dirname(app.program)],
                };
            }
        } else {
            app.monoDebuggerOptions = debuggerOptions;
        }

        this.logger.info(
            `[DEBUGGER] Blazor managed debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                app
            )}`
        );

        return { app, inspectUri: inspectUriRet, portBrowserDebug, nativeBridgeReadiness };
    }

    private async waitForNativeBrowserBridge(
        bridgeToken: string,
        metadataToken: string | undefined,
        expectedBrowserPort: number,
        timeoutMilliseconds: number,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ inspectUri: string; browserPort: number }> {
        if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new Error('The native browser bridge readiness timeout must be greater than zero.');
        }

        return new Promise((resolve, reject) => {
            let completed = false;
            let metadataReady = metadataToken === undefined;
            let bridgeReady: { inspectUri: string; browserPort: number } | undefined;
            let managedSession: vscode.DebugSession | undefined;
            const disposables: vscode.Disposable[] = [];
            const timeout = setTimeout(
                () => finish(new Error(`Native browser bridge readiness timed out after ${timeoutMilliseconds} ms.`)),
                timeoutMilliseconds
            );

            const dispose = () => {
                clearTimeout(timeout);
                for (const disposable of disposables) {
                    disposable.dispose();
                }
            };
            const finish = (error?: Error) => {
                if (completed) {
                    return;
                }
                completed = true;
                dispose();
                if (error) {
                    if (managedSession) {
                        void this.vscodeType.debug.stopDebugging(managedSession);
                    }
                    reject(error);
                } else if (bridgeReady) {
                    resolve(bridgeReady);
                }
            };
            const tryComplete = () => {
                if (metadataReady && bridgeReady) {
                    finish();
                }
            };

            disposables.push(
                this.vscodeType.debug.onDidStartDebugSession((session) => {
                    if (session.configuration.remoteBrowserBridge?.token === bridgeToken) {
                        managedSession = session;
                    }
                }),
                this.vscodeType.debug.onDidTerminateDebugSession((session) => {
                    if (session.configuration.remoteBrowserBridge?.token === bridgeToken) {
                        finish(
                            new Error('The managed WebAssembly debug session ended before native bridge readiness.')
                        );
                    }
                }),
                this.vscodeType.debug.onDidReceiveDebugSessionCustomEvent((event) => {
                    const body = event.body as NativeBrowserBridgeReadyBody | undefined;
                    if (event.event === 'dotnet/localMetadataReady' && body && body.token === metadataToken) {
                        if (body.success !== true) {
                            finish(new Error(body.error || 'Native local metadata preload failed.'));
                            return;
                        }
                        metadataReady = true;
                        tryComplete();
                        return;
                    }
                    if (event.event !== 'dotnet/browserBridgeReady' || body?.token !== bridgeToken) {
                        return;
                    }
                    if (body.success !== true) {
                        finish(new Error(body.error || 'Native browser bridge preparation failed.'));
                        return;
                    }
                    if (
                        body.browserPort !== expectedBrowserPort ||
                        typeof body.inspectUri !== 'string' ||
                        body.inspectUri.length === 0
                    ) {
                        finish(new Error('Native browser bridge readiness returned an invalid port or inspect URI.'));
                        return;
                    }
                    bridgeReady = { inspectUri: body.inspectUri, browserPort: expectedBrowserPort };
                    tryComplete();
                })
            );
            if (cancellationToken) {
                disposables.push(
                    cancellationToken.onCancellationRequested(() =>
                        finish(new Error('Native browser bridge preparation was canceled.'))
                    )
                );
                if (cancellationToken.isCancellationRequested) {
                    finish(new Error('Native browser bridge preparation was canceled.'));
                }
            }
        });
    }

    private static validateBrowserPort(port: number): void {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('The native browser bridge port must be an integer between 1 and 65535.');
        }
    }

    private static async findAvailableBrowserPort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.unref();
            server.once('error', reject);
            server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    server.close();
                    reject(new Error('Unable to allocate a native browser debugging port.'));
                    return;
                }
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(address.port);
                    }
                });
            });
        });
    }

    /**
     * Acquires the dotnet runtime path from the .NET Runtime extension,
     * falling back to the global dotnet if the extension is unavailable.
     */
    private static async acquireDotnetPath(): Promise<string> {
        const prototypeDotnet = process.env.VSCODE_CSHARP_WASMDBG_DOTNET;
        if (prototypeDotnet !== undefined) {
            if (!path.isAbsolute(prototypeDotnet) || !statSync(prototypeDotnet).isFile()) {
                throw new Error('Configured prototype dotnet must be an existing absolute native executable path.');
            }
            return prototypeDotnet;
        }
        const findPathRequest: IDotnetFindPathContext = {
            acquireContext: {
                version: DotNetRuntimeVersion,
                requestingExtensionId: CSharpExtensionId,
                architecture: process.arch,
                mode: 'aspnetcore',
            },
            versionSpecRequirement: 'greater_than_or_equal',
            rejectPreviews: true,
        };

        try {
            let acquireResult = await vscode.commands.executeCommand<IDotnetAcquireResult | undefined>(
                'dotnet.findPath',
                findPathRequest
            );
            if (acquireResult === undefined) {
                const acquireContext: IDotnetAcquireContext = {
                    version: DotNetRuntimeVersion.substring(0, DotNetRuntimeVersion.lastIndexOf('.')),
                    requestingExtensionId: CSharpExtensionId,
                    mode: 'aspnetcore',
                };
                acquireResult = await vscode.commands.executeCommand<IDotnetAcquireResult>(
                    'dotnet.acquire',
                    acquireContext
                );
            }
            if (acquireResult?.dotnetPath) {
                return acquireResult.dotnetPath;
            }
        } catch {
            // Fall through to global dotnet
        }

        return process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    }

    private static async launchVsWebAssemblyBridge(
        urlStr: string,
        useCoreClr: boolean
    ): Promise<[string, number, number]> {
        const dotnetPath = await BlazorDebugConfigurationProvider.acquireDotnetPath();
        const devToolsUrl = `http://localhost:0`; // Browser debugging port address
        const spawnedProxyArgs = [
            `${BlazorDebugConfigurationProvider.getWebAssemblyWebBridgePath()}`,
            '--DevToolsUrl',
            `${devToolsUrl}`,
            '--UseVsDbg',
            'true',
            '--UseCoreClr',
            useCoreClr ? 'true' : 'false',
            '--iCorDebugPort',
            '-1',
            '--OwnerPid',
            `${process.pid}`,
        ];
        const cpOptions: cp.SpawnOptionsWithoutStdio = {
            detached: process.env.VSCODE_CSHARP_WASMDBG_DOTNET === undefined,
            windowsHide: true,
            env: {
                ...process.env,
                DOTNET_ROOT: path.dirname(dotnetPath),
                DOTNET_MULTILEVEL_LOOKUP: '0',
                ...(process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR
                    ? { WASMDBG_ARTIFACT_DIR: process.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR }
                    : {}),
            },
        };
        let chunksProcessed = 0;
        let proxyICorDebugPort = -1;
        let proxyBrowserPort = -1;
        let newUri = '';
        const spawnedProxy = cp.spawn(dotnetPath, spawnedProxyArgs, cpOptions);
        const eventEmmiter = new EventEmitter();
        spawnedProxy.on('error', (err) => {
            BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(
                `Failed to spawn proxy: ${err.message}`
            );
            eventEmmiter.emit('vsWebAssemblyReady');
        });
        spawnedProxy.on('close', (code) => {
            if (newUri === '') {
                BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(
                    `Proxy process exited with code ${code} before it was ready`
                );
                eventEmmiter.emit('vsWebAssemblyReady');
            }
        });
        function handleData(stream: NodeJS.ReadableStream) {
            stream.on('data', (chunk) => {
                BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(chunk.toString());
                if (newUri != '') {
                    return;
                }
                if (chunksProcessed++ > 10) {
                    eventEmmiter.emit('vsWebAssemblyReady');
                }
                const matchExprProxyUrl = 'Now listening on: (?<url>.*)';
                const matchExprICorDebugPort = 'Listening iCorDebug on: (?<port>.*)';
                const matchExprBrowserPort = 'Waiting for browser on: (?<port>.*)';
                const foundProxyUrl = `${chunk}`.match(matchExprProxyUrl);
                const foundICorDebugPort = `${chunk}`.match(matchExprICorDebugPort);
                const foundBrowserPort = `${chunk}`.match(matchExprBrowserPort);
                const proxyUrlString = foundProxyUrl?.groups?.url;
                if (foundICorDebugPort?.groups?.port != undefined) {
                    proxyICorDebugPort = Number(foundICorDebugPort?.groups?.port);
                }
                if (foundBrowserPort?.groups?.port != undefined) {
                    proxyBrowserPort = Number(foundBrowserPort?.groups?.port);
                }
                if (proxyUrlString) {
                    BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(
                        `Debugging proxy is running at: ${proxyUrlString}`
                    );
                    const oldPid = BlazorDebugConfigurationProvider.pidsByUrl.get(urlStr);
                    if (oldPid !== undefined && oldPid > 0) {
                        try {
                            process.kill(oldPid);
                        } catch {
                            // Process may have already terminated
                        }
                    }
                    if (spawnedProxy.pid !== undefined) {
                        BlazorDebugConfigurationProvider.pidsByUrl.set(urlStr, spawnedProxy.pid);
                    }
                    const url = new URL(proxyUrlString);
                    newUri = `${url.protocol.replace(`http`, `ws`)}//${url.host}{browserInspectUriPath}`;
                    eventEmmiter.emit('vsWebAssemblyReady');
                }
            });

            stream.on('error', (err) => {
                BlazorDebugConfigurationProvider.vsWebAssemblyBridgeOutputChannel.appendLine(err.toString());
                eventEmmiter.emit('vsWebAssemblyReady');
            });
        }

        handleData(spawnedProxy.stdout);
        handleData(spawnedProxy.stderr);
        await new Promise((resolve) => eventEmmiter.once('vsWebAssemblyReady', resolve));
        return [newUri, proxyICorDebugPort, proxyBrowserPort];
    }

    /**
     * Determines if the project targets .NET 9 or newer using the C# Dev Kit
     * IDebugTargetFrameworkService. Falls back to csproj parsing if the service
     * is unavailable.
     */
    private static async isNet9OrNewer(projectPath: string): Promise<boolean> {
        const devKitResult = await BlazorDebugConfigurationProvider.isNet9OrNewerViaDevKit(projectPath);
        if (devKitResult !== undefined) {
            return devKitResult;
        }
        return BlazorDebugConfigurationProvider.isNet9OrNewerViaCsproj(projectPath);
    }

    private static async isNet9OrNewerViaDevKit(projectPath: string): Promise<boolean | undefined> {
        const devKit = getCSharpDevKit();
        if (!devKit) {
            return undefined;
        }
        const proxy = await devKit.exports.serviceBroker.getProxy<IDebugTargetFrameworkService>(
            targetFrameworkServiceDescriptor
        );
        if (!proxy) {
            return undefined;
        }
        try {
            const tfmPattern = /^net(\d+)\.\d+/;
            const infos = await new Promise<ProjectDebugTargetFrameworkInfo[]>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
                const observer = new Observer<ProjectDebugTargetFrameworkInfo[]>((value) => {
                    clearTimeout(timeout);
                    resolve(value);
                });
                proxy.subscribe(observer).catch((e) => {
                    clearTimeout(timeout);
                    reject(e);
                });
            });
            const normalizePath = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();
            for (const info of infos) {
                if (projectPath !== '' && normalizePath(info.fullPath) !== normalizePath(projectPath)) {
                    continue;
                }
                // Check debugTargetFramework
                if (info.debugTargetFramework) {
                    const match = info.debugTargetFramework.match(tfmPattern);
                    if (match && parseInt(match[1]) >= 9) {
                        return true;
                    }
                }
                // Check all available target frameworks
                for (const fw of info.availableTargetFrameworks ?? []) {
                    const match = fw.framework.match(tfmPattern);
                    if (match && parseInt(match[1]) >= 9) {
                        return true;
                    }
                }
            }
            return false;
        } catch {
            return undefined;
        } finally {
            proxy?.dispose();
        }
    }

    private static async isNet9OrNewerViaCsproj(projectPath: string): Promise<boolean> {
        const tfmPattern = /^net(\d+)\.\d+/;
        const csprojFiles = await BlazorDebugConfigurationProvider.findCsprojFiles(projectPath);
        for (const csproj of csprojFiles) {
            const tfms = BlazorDebugConfigurationProvider.parseTfmsFromCsproj(csproj);
            for (const tfm of tfms) {
                const match = tfm.match(tfmPattern);
                if (match && parseInt(match[1]) >= 9) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Determines whether the WASM project is configured to use the CoreCLR runtime
     * instead of the default Mono runtime. This is true when the project explicitly
     * opts in via `<UseCoreCLR>true</UseCoreCLR>`, or opts out of Mono via
     * `<UseMonoRuntime>false</UseMonoRuntime>` (the property currently used to switch
     * browser-wasm projects to the CoreCLR runtime).
     */
    public static async isCoreClrRuntime(projectPath: string): Promise<boolean> {
        const csprojFiles = await BlazorDebugConfigurationProvider.findCsprojFiles(projectPath);
        for (const csproj of csprojFiles) {
            if (BlazorDebugConfigurationProvider.usesCoreClrRuntime(csproj)) {
                return true;
            }
        }
        return false;
    }

    private static usesCoreClrRuntime(csprojPath: string): boolean {
        try {
            const content = readFileSync(csprojPath, 'utf-8');
            const useCoreClrMatch = content.match(/<UseCoreCLR>\s*(.*?)\s*<\/UseCoreCLR>/i);
            if (useCoreClrMatch !== null) {
                return useCoreClrMatch[1].trim().toLowerCase() === 'true';
            }
            const useMonoRuntimeMatch = content.match(/<UseMonoRuntime>\s*(.*?)\s*<\/UseMonoRuntime>/i);
            if (useMonoRuntimeMatch !== null) {
                return useMonoRuntimeMatch[1].trim().toLowerCase() === 'false';
            }
            return false;
        } catch {
            return false;
        }
    }

    private static async findCsprojFiles(projectPath: string): Promise<string[]> {
        if (projectPath === '') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                return [];
            }
            const results: string[] = [];
            for (const folder of workspaceFolders) {
                const folderCsprojs = await BlazorDebugConfigurationProvider.findCsprojFiles(folder.uri.fsPath);
                results.push(...folderCsprojs);
            }
            return results;
        }
        // If the path is a .csproj file itself, return it directly
        if (projectPath.endsWith('.csproj') && existsSync(projectPath)) {
            return [projectPath];
        }
        // Otherwise treat it as a directory and search for .csproj files
        try {
            const entries = await promises.readdir(projectPath);
            return entries.filter((e) => e.endsWith('.csproj')).map((e) => path.join(projectPath, e));
        } catch {
            return [];
        }
    }

    private static parseTfmsFromCsproj(csprojPath: string): string[] {
        try {
            const content = readFileSync(csprojPath, 'utf-8');
            // Match <TargetFramework>net9.0</TargetFramework>
            const singleMatch = content.match(/<TargetFramework>(.*?)<\/TargetFramework>/);
            if (singleMatch) {
                return [singleMatch[1].trim()];
            }
            // Match <TargetFrameworks>net8.0;net9.0</TargetFrameworks>
            const multiMatch = content.match(/<TargetFrameworks>(.*?)<\/TargetFrameworks>/);
            if (multiMatch) {
                return multiMatch[1].split(';').map((t) => t.trim());
            }
        } catch {
            // If we can't read the file, fall through
        }
        return [];
    }
    private static async useVSDbg(projectPath: string): Promise<boolean> {
        const existWebAssemblyWebBridge = existsSync(BlazorDebugConfigurationProvider.getWebAssemblyWebBridgePath());
        if (!existWebAssemblyWebBridge) {
            return false;
        }

        // CoreCLR-based WASM projects have no Mono debugging path, so the VsWebAssemblyBridge
        // must always be used for them, regardless of the `wasm.debug.useVSDbg` setting or TFM.
        if (await BlazorDebugConfigurationProvider.isCoreClrRuntime(projectPath)) {
            return true;
        }

        const wasmConfig = vscode.workspace.getConfiguration('csharp');
        const useVSDbg = wasmConfig.get<boolean>('wasm.debug.useVSDbg') == true;
        if (!useVSDbg) {
            return false;
        }
        const isNet9OrNewer = await BlazorDebugConfigurationProvider.isNet9OrNewer(projectPath);
        return useVSDbg && isNet9OrNewer;
    }

    private static getWebAssemblyWebBridgePath() {
        const vsWebAssemblyBridge = path.join(
            getExtensionPath(),
            '.vswebassemblybridge',
            'Microsoft.Diagnostics.BrowserDebugHost.dll'
        );
        return vsWebAssemblyBridge;
    }

    public static async tryToUseVSDbgForMono(urlStr: string, projectPath: string): Promise<[string, number, number]> {
        // Enable session tracking — C# Dev Kit calls this method directly
        // (bypassing resolveDebugConfiguration), so we start tracking here.
        BlazorDebugConfigurationProvider.trackedSessionIds.clear();
        BlazorDebugConfigurationProvider.trackedSessionsById.clear();
        BlazorDebugConfigurationProvider.isTrackingSessions = true;

        const useVSDbg = await BlazorDebugConfigurationProvider.useVSDbg(projectPath);

        if (useVSDbg) {
            const useCoreClr = await BlazorDebugConfigurationProvider.isCoreClrRuntime(projectPath);
            const [inspectUri, portICorDebug, portBrowserDebug] =
                await BlazorDebugConfigurationProvider.launchVsWebAssemblyBridge(urlStr, useCoreClr);

            return [inspectUri, portICorDebug, portBrowserDebug];
        }
        return ['', -1, -1];
    }

    public static async determineBrowserType(): Promise<string | undefined> {
        // TODO: temporarily force Chrome for local testing/repro; revert before merge.
        return BlazorDebugConfigurationProvider.chromeBrowserType;

        // eslint-disable-next-line no-unreachable
        // There was no browser specified by the user, so we will do some auto-detection to find a browser,
        // favoring Edge if multiple valid options are installed.
        const edgeBrowserFinder = new EdgeBrowserFinder(process.env, promises);
        const edgeInstallations = await edgeBrowserFinder.findAll();
        if (edgeInstallations.length > 0) {
            showInformationMessage(
                vscode,
                BlazorDebugConfigurationProvider.autoDetectUserNotice.replace('{0}', `'Edge'`)
            );

            return BlazorDebugConfigurationProvider.edgeBrowserType;
        }

        const chromeBrowserFinder = new ChromeBrowserFinder(process.env, promises);
        const chromeInstallations = await chromeBrowserFinder.findAll();
        if (chromeInstallations.length > 0) {
            showInformationMessage(
                vscode,
                BlazorDebugConfigurationProvider.autoDetectUserNotice.replace('{0}', `'Chrome'`)
            );

            return BlazorDebugConfigurationProvider.chromeBrowserType;
        }

        showErrorMessage(
            vscode,
            vscode.l10n.t('Run and Debug: A valid browser is not installed. Please install Edge or Chrome.')
        );
        return undefined;
    }
}
