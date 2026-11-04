/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import * as vscode from 'vscode';
import { ChromeBrowserFinder, EdgeBrowserFinder } from '@vscode/js-debug-browsers';
import { ONLY_JS_DEBUG_NAME, MANAGED_DEBUG_NAME, JS_DEBUG_NAME, SERVER_APP_NAME } from './constants';
import { isValidEvent, onDidTerminateDebugSession } from './terminateDebugHandler';
import { findBrowserDebugPort, getCoreClrBrowserProgram, parseBrowserBridgeReady } from './browserBridge';
import type { IWorkspaceDebugInformationProvider } from '../../../shared/IWorkspaceDebugInformationProvider';
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
        private readonly vscodeType: typeof vscode,
        private readonly workspaceDebugInfoProvider?: IWorkspaceDebugInformationProvider
    ) {}

    public static register(
        logger: vscode.LogOutputChannel,
        vscodeType: typeof vscode,
        workspaceDebugInfoProvider?: IWorkspaceDebugInformationProvider
    ) {
        const provider = new BlazorDebugConfigurationProvider(logger, vscodeType, workspaceDebugInfoProvider);
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
        const useVSDbg = await BlazorDebugConfigurationProvider.useVSDbg(projectPath);
        let portBrowserDebug = -1;
        if (useVSDbg) {
            const managedDebugConfiguration = await this.createManagedDebugConfigurationOnBrowser(
                configuration,
                url,
                projectPath,
                folder,
                cancellationToken
            );
            inspectUri = managedDebugConfiguration.inspectUri;
            portBrowserDebug = managedDebugConfiguration.portBrowserDebug;
            const bridgeToken = managedDebugConfiguration.bridgeToken;
            const preloadToken =
                managedDebugConfiguration.app.type === 'coreclr_wasm' && process.env.DOTNET_DbgLocalMetadataPath
                    ? randomUUID()
                    : undefined;
            if (preloadToken) {
                managedDebugConfiguration.app.localMetadataPreloadToken = preloadToken;
            }
            const startManagedDebugging = async () => {
                try {
                    this.logger.info(
                        `[DEBUGGER] Starting Blazor managed debug configuration: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                            managedDebugConfiguration.app
                        )}`
                    );
                    const didStart = await this.vscodeType.debug.startDebugging(folder, managedDebugConfiguration.app);
                    if (!didStart) {
                        this.logger.warn(
                            `[DEBUGGER] Blazor managed debug configuration did not start: ${BlazorDebugConfigurationProvider.stringifyDebugConfiguration(
                                managedDebugConfiguration.app
                            )}`
                        );
                        if (preloadToken || bridgeToken) {
                            throw new Error('The managed debugger did not start before browser launch.');
                        }
                    }
                } catch (error) {
                    this.logger.error(
                        '[DEBUGGER] Error when launching Blazor managed debug configuration: ',
                        error as Error
                    );
                    if (preloadToken || bridgeToken) {
                        throw error;
                    }
                }
            };

            if (preloadToken || bridgeToken) {
                let resolveReady!: () => void;
                let rejectReady!: (error: Error) => void;
                let metadataReady = !preloadToken;
                let bridgeReady = !bridgeToken;
                let managedSession: vscode.DebugSession | undefined;
                let startupFailed = false;
                let launch: Promise<void> | undefined;
                let stoppingManaged: Promise<void> | undefined;
                const stopManaged = async () => {
                    if (managedSession) {
                        stoppingManaged ??= Promise.resolve(this.vscodeType.debug.stopDebugging(managedSession));
                    }
                    return stoppingManaged ?? Promise.resolve();
                };
                const logStopFailure = (error: unknown) =>
                    this.logger.error(
                        '[DEBUGGER] Could not stop the managed debugger after browser startup failed.',
                        error instanceof Error ? error : new Error(String(error))
                    );
                const ready = new Promise<void>((resolve, reject) => {
                    resolveReady = resolve;
                    rejectReady = reject;
                });
                const subscription = this.vscodeType.debug.onDidReceiveDebugSessionCustomEvent((event) => {
                    if (event.session.type !== 'coreclr_wasm') {
                        return;
                    }
                    if (
                        preloadToken &&
                        event.event === 'dotnet/localMetadataReady' &&
                        event.body?.token === preloadToken
                    ) {
                        managedSession = event.session;
                        if (event.body.success !== true || !(event.body.metadataCount > 0)) {
                            rejectReady(new Error(event.body?.error ?? 'Local metadata preloading failed.'));
                            return;
                        }
                        metadataReady = true;
                    }
                    if (
                        bridgeToken &&
                        event.event === 'dotnet/browserBridgeReady' &&
                        event.body?.token === bridgeToken
                    ) {
                        managedSession = event.session;
                        try {
                            inspectUri = parseBrowserBridgeReady(event.body, portBrowserDebug);
                            bridgeReady = true;
                        } catch (error) {
                            rejectReady(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                    }
                    if (metadataReady && bridgeReady) {
                        resolveReady();
                    }
                });
                const started = this.vscodeType.debug.onDidStartDebugSession((session) => {
                    if (
                        session.type === 'coreclr_wasm' &&
                        ((bridgeToken && session.configuration.remoteBrowserBridge?.token === bridgeToken) ||
                            (preloadToken && session.configuration.localMetadataPreloadToken === preloadToken))
                    ) {
                        managedSession = session;
                        if (startupFailed) {
                            void stopManaged().catch(logStopFailure);
                        }
                    }
                });
                const terminated = this.vscodeType.debug.onDidTerminateDebugSession((session) => {
                    if (session.id === managedSession?.id) {
                        rejectReady(new Error('The managed debugger terminated before the browser was ready.'));
                    } else if (
                        bridgeToken &&
                        bridgeReady &&
                        session.configuration.port === portBrowserDebug &&
                        session.configuration.inspectUri === inspectUri
                    ) {
                        startupFailed = true;
                        rejectReady(new Error('The browser debugger terminated during managed startup.'));
                        void stopManaged().catch(logStopFailure);
                    }
                });
                const timer = setTimeout(
                    () => rejectReady(new Error('The managed debugger was not ready before browser launch.')),
                    30000
                );
                const cancelled = cancellationToken?.onCancellationRequested(() => {
                    startupFailed = true;
                    rejectReady(new vscode.CancellationError());
                    void stopManaged().catch(logStopFailure);
                });
                try {
                    if (cancellationToken?.isCancellationRequested) {
                        rejectReady(new vscode.CancellationError());
                    } else {
                        launch = startManagedDebugging();
                        void launch.catch(rejectReady);
                    }
                    await ready;
                } catch (error) {
                    startupFailed = true;
                    await stopManaged();
                    throw error;
                } finally {
                    clearTimeout(timer);
                    subscription.dispose();
                    const disposeStartupObservers = () => {
                        started.dispose();
                        terminated.dispose();
                        cancelled?.dispose();
                    };
                    if (launch) {
                        void launch.then(disposeStartupObservers, disposeStartupObservers);
                    } else {
                        disposeStartupObservers();
                    }
                }
            } else if (managedDebugConfiguration.app.type === 'coreclr_wasm') {
                void startManagedDebugging();
            } else {
                await startManagedDebugging();
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
        folder?: vscode.WorkspaceFolder,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{
        app: vscode.DebugConfiguration;
        inspectUri: string;
        portBrowserDebug: number;
        bridgeToken?: string;
    }> {
        const useCoreClr = await BlazorDebugConfigurationProvider.isCoreClrRuntime(projectPath);
        const proxyFree = useCoreClr && process.platform === 'win32';
        const bridgeToken = proxyFree ? randomUUID() : undefined;
        let inspectUriRet: string;
        let portICorDebug: number;
        let portBrowserDebug: number;
        if (proxyFree) {
            portBrowserDebug = await findBrowserDebugPort();
            portICorDebug = portBrowserDebug;
            inspectUriRet = '';
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
        };

        const debuggerOptions = {
            ip: '127.0.0.1',
            port: portICorDebug,
            platform: useCoreClr ? 'browser;x64' : 'browser',
            isServer: !proxyFree,
        };
        if (useCoreClr) {
            app.coreClrMobileDebuggerOptions = {
                ...app.coreClrMobileDebuggerOptions,
                ...debuggerOptions,
            };
            if (proxyFree && !app.program) {
                const projects = await this.workspaceDebugInfoProvider?.getWorkspaceDebugInformation(
                    folder?.uri ?? vscode.Uri.file(path.dirname(projectPath)),
                    cancellationToken
                );
                if (cancellationToken?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                app.program = getCoreClrBrowserProgram(projects, projectPath);
                app.cwd = path.dirname(projectPath);
            }
            if (proxyFree && !app.coreClrMobileDebuggerOptions.assetsPath && typeof app.program === 'string') {
                app.coreClrMobileDebuggerOptions.assetsPath = path.dirname(app.program);
            }
            if (bridgeToken) {
                app.remoteBrowserBridge = {
                    token: bridgeToken,
                    browserPort: portBrowserDebug,
                    appUrl: configuration.url || url,
                };
            }
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

        return { app, inspectUri: inspectUriRet, portBrowserDebug, bridgeToken };
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
        const useCoreClr = await BlazorDebugConfigurationProvider.isCoreClrRuntime(projectPath);
        if (useCoreClr && process.platform === 'win32') {
            return true;
        }
        const existWebAssemblyWebBridge = existsSync(BlazorDebugConfigurationProvider.getWebAssemblyWebBridgePath());
        if (!existWebAssemblyWebBridge) {
            return false;
        }

        // CoreCLR requires the VsDbg path regardless of the Mono preference or TFM.
        if (useCoreClr) {
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
            if (useCoreClr && process.platform === 'win32') {
                throw new Error(
                    'CoreCLR WebAssembly requires the native browser bridge launch through a blazorwasm configuration. ' +
                        'The Mono bridge export cannot coordinate native bridge readiness.'
                );
            }
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
