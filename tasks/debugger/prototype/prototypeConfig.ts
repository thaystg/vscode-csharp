/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { assertRunnableWorkload } from '../../../test/lsptoolshost/integrationTests/debuggerWorkload';

export interface HostPlatform {
    platform: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
    key: string;
    dap: string;
    concordEngine: string;
    dbi: string;
    dac: string;
    validation: string;
}
export function hostPlatform(platform: string, architecture: string): HostPlatform {
    const arch = ['amd64', 'x86_64', 'x64'].includes(architecture) ? 'x64' : architecture;
    if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
        throw new Error(
            `Unsupported prototype host ${platform}-${architecture}: requires a supplied x64/arm64 native cohort.`
        );
    }
    const windows = platform === 'win32';
    const mac = platform === 'darwin';
    return {
        platform: platform as HostPlatform['platform'],
        arch: arch as HostPlatform['arch'],
        key: `${platform}-${arch}`,
        dap: windows ? 'vsdbg-ui.exe' : 'vsdbg-ui',
        concordEngine: windows ? 'vsdebugeng.impl.dll' : mac ? 'libvsdebugeng.impl.dylib' : 'libvsdebugeng.impl.so',
        dbi: windows ? 'mscordbi_universal.dll' : mac ? 'libmscordbi_universal.dylib' : 'libmscordbi_universal.so',
        dac: windows
            ? 'mscordaccore_universal.dll'
            : mac
              ? 'libmscordaccore_universal.dylib'
              : 'libmscordaccore_universal.so',
        validation:
            mac && arch === 'arm64'
                ? 'macOS arm64 prior cohort end-to-end validated; this configuration not run'
                : 'Intended host only: configuration-tested, end-to-end unvalidated; requires ported native components',
    };
}
export interface AssetList {
    cohortId: string;
    files: { path: string; size: number; sha256: string }[];
}
export interface SourceManifest {
    schemaVersion: 1;
    cohortId: string;
    targetArchitecture: 'wasm32';
    versions: Record<string, string>;
    sources?: {
        id: string;
        origin: string;
        ref: string;
        commit: string;
        localPatch?: { path: string; sha256: string };
    }[];
    hosts: Record<
        string,
        {
            concord: AssetList;
            proxy: AssetList;
            native: AssetList;
            endToEndValidated: boolean;
            features: { wasmdbgArtifactDir: boolean };
        }
    >;
    runtimePack: AssetList;
    workloads: Record<
        'small' | 'havit',
        AssetList & {
            assembly: string;
            appDll: string;
            appPdb: string;
            nativeWasm: string;
            handoffSha256: string;
            sourceFiles: { path: string; sha256: string }[];
        }
    >;
}
export interface MachineConfig {
    extensionRoot: string;
    artifactRoot: string;
    profileRoot: string;
    manifest: string;
    paths: {
        runtimeRoot: string;
        havitRoot: string;
        runtimePack: string;
        concordPublish: string;
        proxyPublish: string;
        nativeAssets: string;
        smallWebRoot: string;
        havitWebRoot: string;
        smallHandoff: string;
        havitHandoff: string;
        havitServerModule: string;
        extensionDependencies: string;
    };
    executables: { vscode: string; browser: string; dotnet: string; dotnetServe: string };
    ports: { small: number; havit: number; dap: number; ui: number };
    sourceMaps: { small: Record<string, string>; havit: Record<string, string> };
    allowUnvalidatedHost?: boolean;
    browserType: 'edge' | 'chrome';
    browserProfile?: string;
    diagnosticLogging?: boolean;
    extendedInspection?: boolean;
    havitClosingAction?: 'stepOver' | 'continue';
}
export function verifiedConcordExecutable(config: MachineConfig, host: HostPlatform, manifest: SourceManifest): string {
    verifyAssets(config.paths.concordPublish, manifest.hosts[host.key].concord, manifest.cohortId, 'Concord');
    const executable = path.join(config.paths.concordPublish, host.dap);
    if (!fs.statSync(executable).isFile()) {
        throw new Error(`Missing ${host.key} Concord executable.`);
    }
    if (host.platform !== 'win32') {
        fs.accessSync(executable, fs.constants.X_OK);
    }
    return executable;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as RecordValue;
}
function text(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a nonempty string.`);
    }
    return value;
}
export function resolveConfigPath(value: unknown, variables: Record<string, string>, configDir: string): string {
    const expanded = text(value, 'config path').replace(/\$\{([^}]+)\}/g, (_, token: string) => {
        if (!variables[token]) {
            throw new Error(`Unresolved config path variable: ${token}`);
        }
        return variables[token];
    });
    return path.resolve(configDir, expanded);
}
function contained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
}
export function knownInstallLocations(
    role: 'vscode' | 'browser',
    host: HostPlatform,
    home: string,
    env: NodeJS.ProcessEnv
): string[] {
    if (host.platform === 'darwin') {
        const apps =
            role === 'vscode'
                ? ['Visual Studio Code.app/Contents/MacOS/Code']
                : [
                      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                      'Google Chrome.app/Contents/MacOS/Google Chrome',
                  ];
        return [path.join(path.sep, 'Applications'), path.join(home, 'Applications')].flatMap((base) =>
            apps.map((app) => path.join(base, app))
        );
    }
    if (host.platform === 'win32') {
        const join = path.win32.join;
        return role === 'vscode'
            ? [
                  env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
                  env.ProgramFiles && join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
              ].filter((p): p is string => !!p)
            : [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
                  .filter((p): p is string => !!p)
                  .flatMap((base) => [
                      join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                      join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                  ]);
    }
    return role === 'vscode'
        ? ['/usr/share/code/code', '/opt/visual-studio-code/code']
        : [
              '/opt/microsoft/msedge/msedge',
              '/opt/google/chrome/chrome',
              '/usr/bin/chromium',
              '/usr/bin/chromium-browser',
          ];
}
export function discoverExecutable(explicit: string | undefined, candidates: string[], exists = fs.existsSync): string {
    if (explicit) {
        if (!exists(explicit)) {
            throw new Error(
                `Configured executable not found: ${explicit}; discovery will not override an explicit path.`
            );
        }
        return explicit;
    }
    const result = candidates.find(exists);
    if (!result) {
        throw new Error(
            'Executable discovery failed. Configure an explicit native executable path; no download will be attempted.'
        );
    }
    return result;
}
export function validateProfilePath(profile: string, host: HostPlatform): void {
    if (host.platform === 'darwin' && Buffer.byteLength(path.join(profile, '1.14-main.sock')) > 103) {
        throw new Error(
            'macOS profile path exceeds the Unix socket limit. Set a short ignored profileRoot; no global symlink is created.'
        );
    }
    if (host.platform === 'linux' && Buffer.byteLength(path.join(profile, '1.14-main.sock')) > 107) {
        throw new Error('Linux profile path exceeds the Unix socket limit. Set a short profileRoot.');
    }
}
export function loadMachineConfig(
    filename: string,
    host = hostPlatform(process.platform, process.arch)
): MachineConfig {
    const raw = object(JSON.parse(fs.readFileSync(filename, 'utf8')), 'machine config');
    if (raw.schemaVersion !== 1) {
        throw new Error('Machine config schemaVersion must be 1.');
    }
    if (raw.allowUnvalidatedHost !== undefined && typeof raw.allowUnvalidatedHost !== 'boolean') {
        throw new Error('allowUnvalidatedHost must be boolean.');
    }
    if (raw.diagnosticLogging !== undefined && typeof raw.diagnosticLogging !== 'boolean') {
        throw new Error('diagnosticLogging must be boolean.');
    }
    if (raw.extendedInspection !== undefined && typeof raw.extendedInspection !== 'boolean') {
        throw new Error('extendedInspection must be boolean.');
    }
    if (
        raw.havitClosingAction !== undefined &&
        raw.havitClosingAction !== 'stepOver' &&
        raw.havitClosingAction !== 'continue'
    ) {
        throw new Error('havitClosingAction must be stepOver or continue.');
    }
    if (raw.browserType !== 'edge' && raw.browserType !== 'chrome') {
        throw new Error('browserType must be edge or chrome.');
    }
    const configDir = path.dirname(path.resolve(filename));
    const variables: Record<string, string> = { configDir, home: os.homedir() };
    const extensionRoot = resolveConfigPath(raw.extensionRoot ?? '../../..', variables, configDir);
    variables.extensionRoot = extensionRoot;
    const artifactRoot = resolveConfigPath(raw.artifactRoot, variables, configDir);
    if (!contained(path.join(extensionRoot, 'out'), artifactRoot)) {
        throw new Error(
            'artifactRoot must be inside the extension worktree out directory, never a primary checkout or historical archive.'
        );
    }
    variables.artifactRoot = artifactRoot;
    const paths = object(raw.paths, 'paths');
    const resolved: Record<string, string> = {};
    for (const key of [
        'runtimeRoot',
        'havitRoot',
        'runtimePack',
        'concordPublish',
        'proxyPublish',
        'nativeAssets',
        'smallWebRoot',
        'havitWebRoot',
        'smallHandoff',
        'havitHandoff',
        'havitServerModule',
        'extensionDependencies',
    ]) {
        resolved[key] = resolveConfigPath(paths[key], variables, configDir);
        variables[key] = resolved[key];
    }
    const ports = object(raw.ports, 'ports');
    const portValues: Record<string, number> = {};
    for (const key of ['small', 'havit', 'dap', 'ui']) {
        const value = ports[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
            throw new Error(`Invalid loopback port: ${key}`);
        }
        portValues[key] = value;
    }
    if (new Set(Object.values(portValues)).size !== 4) {
        throw new Error('Prototype ports must be distinct.');
    }
    const exes = object(raw.executables, 'executables');
    const executables: Record<string, string> = {};
    for (const key of ['vscode', 'browser', 'dotnet', 'dotnetServe']) {
        const explicit = exes[key] === undefined ? undefined : resolveConfigPath(exes[key], variables, configDir);
        executables[key] = discoverExecutable(
            explicit,
            key === 'vscode' || key === 'browser' ? knownInstallLocations(key, host, os.homedir(), process.env) : []
        );
    }
    const sourceMaps = object(raw.sourceMaps, 'sourceMaps');
    const resolvedMaps: Record<string, Record<string, string>> = {};
    for (const selector of ['small', 'havit']) {
        const map = object(sourceMaps[selector], `sourceMaps.${selector}`);
        resolvedMaps[selector] = Object.fromEntries(
            Object.entries(map).map(([key, value]) => [
                key.replace(/\$\{([^}]+)\}/g, (_, token: string) => {
                    if (!variables[token]) {
                        throw new Error(`Unresolved source map variable: ${token}`);
                    }
                    return variables[token];
                }),
                resolveConfigPath(value, variables, configDir),
            ])
        );
    }
    const profileRoot = resolveConfigPath(raw.profileRoot, variables, configDir);
    if (!fs.existsSync(path.dirname(profileRoot))) {
        throw new Error(
            'profileRoot must have an existing parent. Use a short explicitly configured private profile area, never a user VS Code profile.'
        );
    }
    validateProfilePath(path.join(profileRoot, 'r-' + '0'.repeat(12)), host);
    // Optional user-authorized shared browser profile (e.g. a policy-required signed-in Edge profile); reported as a deviation.
    const browserProfile =
        raw.browserProfile === undefined ? undefined : resolveConfigPath(raw.browserProfile, variables, configDir);
    if (browserProfile && !fs.statSync(browserProfile).isDirectory()) {
        throw new Error('browserProfile must be an existing dedicated browser user-data directory.');
    }
    return {
        extensionRoot,
        artifactRoot,
        profileRoot,
        manifest: resolveConfigPath(raw.manifest, variables, configDir),
        paths: resolved as MachineConfig['paths'],
        executables: executables as MachineConfig['executables'],
        ports: portValues as MachineConfig['ports'],
        sourceMaps: resolvedMaps as MachineConfig['sourceMaps'],
        allowUnvalidatedHost: raw.allowUnvalidatedHost === true,
        browserType: raw.browserType,
        ...(browserProfile ? { browserProfile } : {}),
        ...(raw.diagnosticLogging === true ? { diagnosticLogging: true } : {}),
        ...(raw.extendedInspection === true ? { extendedInspection: true } : {}),
        ...(raw.havitClosingAction ? { havitClosingAction: raw.havitClosingAction as 'stepOver' | 'continue' } : {}),
    };
}
export function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
export function verifyAssets(directory: string, value: unknown, cohortId: string, label: string): AssetList {
    const list = object(value, label);
    if (list.cohortId !== cohortId || !Array.isArray(list.files) || !list.files.length) {
        throw new Error(`${label}: missing complete asset list or mismatched cohortId.`);
    }
    const seen = new Set<string>();
    for (const raw of list.files) {
        const f = object(raw, `${label} file`);
        const name = text(f.path, 'asset path');
        if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..') || seen.has(name)) {
            throw new Error(`${label}: unsafe or duplicate asset path ${name}`);
        }
        seen.add(name);
        if (
            typeof f.size !== 'number' ||
            f.size < 0 ||
            !Number.isInteger(f.size) ||
            typeof f.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(f.sha256)
        ) {
            throw new Error(`${label}: invalid size/hash ${name}`);
        }
        const target = path.join(directory, name);
        if (fs.statSync(target).size !== f.size || sha256(target) !== f.sha256) {
            throw new Error(`${label}: asset hash/size mismatch ${name}`);
        }
    }
    function files(relative = ''): string[] {
        return fs
            .readdirSync(path.join(directory, relative), { withFileTypes: true })
            .flatMap((e) =>
                e.isDirectory()
                    ? files(path.join(relative, e.name))
                    : [path.join(relative, e.name).split(path.sep).join('/')]
            );
    }
    const actual = files()
        .filter((name) => name !== 'install.Lock')
        .sort();
    const declared = [...seen].filter((name) => name !== 'install.Lock').sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
        throw new Error(
            `${label}: directory contains undeclared/missing assets; supply a complete fresh publish, not a stale overlay.`
        );
    }
    return {
        cohortId,
        files: list.files.map((raw) => {
            const f = object(raw, `${label} file`);
            return { path: text(f.path, 'asset path'), size: f.size as number, sha256: text(f.sha256, 'asset hash') };
        }),
    };
}
export function preflight(config: MachineConfig, host = hostPlatform(process.platform, process.arch)): SourceManifest {
    if (Number(process.versions.node.split('.')[0]) < 22) {
        throw new Error(
            'Prototype Node helpers require Node 22+ (fetch/WebSocket); no runtime download will be attempted.'
        );
    }
    const m = object(JSON.parse(fs.readFileSync(config.manifest, 'utf8')), 'source manifest');
    const cohortId = text(m.cohortId, 'cohortId');
    if (m.schemaVersion !== 1 || m.targetArchitecture !== 'wasm32') {
        throw new Error(
            'Source manifest requires schemaVersion1/targetArchitecture wasm32; host architecture is separate.'
        );
    }
    const hosts = object(m.hosts, 'hosts');
    const selected = hosts[host.key];
    if (!selected) {
        throw new Error(
            `No native source/artifact cohort for ${host.key}. Only supplied hosts may run; no macOS fallback.`
        );
    }
    const h = object(selected, host.key);
    if (!h.features || object(h.features, 'host features').wasmdbgArtifactDir !== true) {
        throw new Error(
            'Proxy cohort lacks WASMDBG_ARTIFACT_DIR support. Use the portable-log source revision from the private guide and build a NEW complete publish/manifest; accepted250aea/41855 is legacy, do not relabel it.'
        );
    }
    if (typeof h.endToEndValidated !== 'boolean') {
        throw new Error('Host validation status must be explicit.');
    }
    if ((host.key !== 'darwin-arm64' || !h.endToEndValidated) && !config.allowUnvalidatedHost) {
        throw new Error(
            `${host.key} is end-to-end unvalidated. Supply matching ported artifacts and explicitly allowUnvalidatedHost for an experimental pilot.`
        );
    }
    verifyAssets(config.paths.concordPublish, h.concord, cohortId, 'Concord');
    verifyAssets(config.paths.proxyPublish, h.proxy, cohortId, 'BrowserDebugHost');
    verifyAssets(config.paths.nativeAssets, h.native, cohortId, 'universal DAC/DBI');
    const runtime = verifyAssets(config.paths.runtimePack, m.runtimePack, cohortId, 'runtime pack');
    for (const name of [host.dap, host.concordEngine]) {
        if (!fs.statSync(path.join(config.paths.concordPublish, name)).isFile()) {
            throw new Error(`Missing ${host.key} Concord artifact ${name}.`);
        }
    }
    for (const name of [host.dbi, host.dac]) {
        if (!fs.statSync(path.join(config.paths.nativeAssets, name)).isFile()) {
            throw new Error(`Missing ${host.key} native artifact ${name}.`);
        }
    }
    for (const file of [
        'Microsoft.Diagnostics.BrowserDebugHost.dll',
        'Microsoft.Diagnostics.BrowserDebugProxy.dll',
        'Microsoft.Diagnostics.BrowserDebugHost.runtimeconfig.json',
    ]) {
        fs.statSync(path.join(config.paths.proxyPublish, file));
    }
    const workloads = object(m.workloads, 'workloads');
    for (const selector of ['small', 'havit'] as const) {
        const webRoot = config.paths[selector === 'small' ? 'smallWebRoot' : 'havitWebRoot'];
        const entry = object(workloads[selector], selector);
        const assets = verifyAssets(webRoot, entry, cohortId, selector);
        for (const key of ['assembly', 'appDll', 'appPdb', 'nativeWasm']) {
            text(entry[key], `${selector}.${key}`);
        }
        if (
            entry.appDll !== `_framework/${entry.assembly}.dll` ||
            entry.appPdb !== `_framework/${entry.assembly}.pdb`
        ) {
            throw new Error(
                `${selector}: original DLL/PDB names under _framework are required by the existing inspection runner.`
            );
        }
        for (const key of ['appDll', 'appPdb', 'nativeWasm']) {
            if (!assets.files.some((f) => f.path === entry[key])) {
                throw new Error(`${selector}: ${key} missing from complete manifest.`);
            }
        }
        const targetHash = assets.files.find((f) => f.path === entry.nativeWasm)!.sha256;
        if (!runtime.files.some((f) => f.path.endsWith('.wasm') && f.sha256 === targetHash)) {
            throw new Error(`${selector}: target WASM does not match the supplied runtime pack.`);
        }
        const handoffFile = config.paths[selector === 'small' ? 'smallHandoff' : 'havitHandoff'];
        if (typeof entry.handoffSha256 !== 'string' || sha256(handoffFile) !== entry.handoffSha256) {
            throw new Error(`${selector}: owner source/PDB readiness handoff hash mismatch or missing.`);
        }
        if (!Array.isArray(entry.sourceFiles) || !entry.sourceFiles.length) {
            throw new Error(`${selector}: frozen source hash proof is required.`);
        }
        for (const rawSource of entry.sourceFiles) {
            const source = object(rawSource, 'source file');
            const sourceRoot = selector === 'small' ? config.paths.runtimeRoot : config.paths.havitRoot;
            const file = path.resolve(sourceRoot, text(source.path, 'source path'));
            if (!contained(sourceRoot, file) || sha256(file) !== source.sha256) {
                throw new Error(`${selector}: frozen source/PDB checksum mismatch ${source.path}`);
            }
        }
        const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
        assertRunnableWorkload(handoff);
        if (handoff.nextPilotHeld === true || handoff.nextPilotHeldUntilVerifiedDacChange === true) {
            throw new Error(
                `${selector}: owner handoff holds launch (${handoff.pilotHoldReason ?? handoff.currentManagedBlocker}).`
            );
        }
        for (const target of Object.values(config.sourceMaps[selector])) {
            if (!fs.statSync(target).isDirectory()) {
                throw new Error(`${selector}: source map destination is not a directory.`);
            }
        }
    }
    for (const role of Object.keys(config.executables) as (keyof MachineConfig['executables'])[]) {
        const file = config.executables[role];
        if (!fs.statSync(file).isFile()) {
            throw new Error(`Executable is not a file: ${role}`);
        }
        if (host.platform !== 'win32') {
            fs.accessSync(file, fs.constants.X_OK);
        }
    }
    fs.statSync(config.paths.havitServerModule);
    if (!fs.statSync(config.paths.extensionDependencies).isDirectory()) {
        throw new Error(
            'extensionDependencies must be a supplied local VS Code extensions directory; no installation/download is performed.'
        );
    }
    fs.statSync(path.join(config.extensionRoot, 'dist/extension.js'));
    // All arrays are re-read through verifyAssets so callers receive the validated asset contract.
    const checkedWorkloads = Object.fromEntries(
        (['small', 'havit'] as const).map((selector) => {
            const entry = object(workloads[selector], selector);
            const assets = verifyAssets(
                config.paths[selector === 'small' ? 'smallWebRoot' : 'havitWebRoot'],
                entry,
                cohortId,
                selector
            );
            return [
                selector,
                {
                    ...assets,
                    assembly: text(entry.assembly, 'assembly'),
                    appDll: text(entry.appDll, 'appDll'),
                    appPdb: text(entry.appPdb, 'appPdb'),
                    nativeWasm: text(entry.nativeWasm, 'nativeWasm'),
                    handoffSha256: text(entry.handoffSha256, 'handoffSha256'),
                    sourceFiles: (entry.sourceFiles as RecordValue[]).map((f) => ({
                        path: text(f.path, 'source path'),
                        sha256: text(f.sha256, 'source hash'),
                    })),
                },
            ];
        })
    ) as SourceManifest['workloads'];
    const versions = Object.fromEntries(
        Object.entries(object(m.versions, 'versions')).map(([key, value]) => [key, text(value, `versions.${key}`)])
    );
    const sources: SourceManifest['sources'] = m.sources === undefined ? undefined : [];
    if (sources) {
        if (!Array.isArray(m.sources) || !m.sources.length) {
            throw new Error('sources must contain immutable repository identities.');
        }
        const ids = new Set<string>();
        for (const raw of m.sources) {
            const source = object(raw, 'source provenance');
            const id = text(source.id, 'source id');
            const commit = text(source.commit, 'source commit');
            if (!/^[a-zA-Z0-9-]+$/.test(id) || ids.has(id) || !/^[0-9a-f]{40}$/.test(commit)) {
                throw new Error('Source provenance requires unique safe IDs and full immutable base commits.');
            }
            ids.add(id);
            const localPatch = source.localPatch === undefined ? undefined : object(source.localPatch, 'local patch');
            let patch: NonNullable<SourceManifest['sources']>[number]['localPatch'];
            if (localPatch) {
                const file = text(localPatch.path, 'local patch path');
                const hash = text(localPatch.sha256, 'local patch hash');
                if (!path.isAbsolute(file) || !/^[0-9a-f]{64}$/.test(hash) || sha256(file) !== hash) {
                    throw new Error(`${id}: local source patch hash/path mismatch.`);
                }
                patch = { path: file, sha256: hash };
            }
            sources.push({
                id,
                origin: text(source.origin, 'source origin'),
                ref: text(source.ref, 'source ref'),
                commit,
                ...(patch ? { localPatch: patch } : {}),
            });
        }
    }
    return {
        schemaVersion: 1,
        cohortId,
        targetArchitecture: 'wasm32',
        versions,
        ...(sources ? { sources } : {}),
        hosts: {
            [host.key]: {
                concord: verifyAssets(config.paths.concordPublish, h.concord, cohortId, 'Concord'),
                proxy: verifyAssets(config.paths.proxyPublish, h.proxy, cohortId, 'BrowserDebugHost'),
                native: verifyAssets(config.paths.nativeAssets, h.native, cohortId, 'universal DAC/DBI'),
                endToEndValidated: h.endToEndValidated,
                features: { wasmdbgArtifactDir: true },
            },
        },
        runtimePack: runtime,
        workloads: checkedWorkloads,
    };
}
