/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { sha256 } = require(path.resolve(__dirname, '../../../out/tasks/debugger/prototype/prototypeConfig.js'));

function copy(source, destination) {
    fs.cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true, force: false });
}
function stageExtension(config, host, manifest) {
    fs.mkdirSync(config.artifactRoot, { recursive: true });
    const stage = path.join(config.artifactRoot, `stage-${host.key}-${randomUUID()}`);
    fs.mkdirSync(stage);
    const extension = path.join(stage, 'extension');
    fs.mkdirSync(extension);
    const packageJson = JSON.parse(fs.readFileSync(path.join(config.extensionRoot, 'package.json'), 'utf8'));
    packageJson.runtimeDependencies = [];
    delete packageJson.scripts;
    fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify(packageJson, null, 2));
    for (const asset of [
        'dist',
        'src',
        'node_modules',
        'l10n',
        'images',
        'snippets',
        'themes',
        'RuntimeLicenses',
        '.roslyn',
        '.roslynDevKit',
        '.xamlTools',
        '.testDiscovery',
        ...fs.readdirSync(config.extensionRoot).filter((name) => /^package\.nls(?:\..+)?\.json$/.test(name)),
    ]) {
        copy(path.join(config.extensionRoot, asset), path.join(extension, asset));
    }
    copy(config.paths.proxyPublish, path.join(extension, '.vswebassemblybridge'));
    const marker = path.join(extension, '.vswebassemblybridge', 'install.Lock');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
    for (const helper of ['captureUi.js', 'navigateWorkloadHistory.js', 'uiInspectAction.js']) {
        copy(path.join(__dirname, helper), path.join(stage, helper));
    }
    fs.mkdirSync(path.join(stage, 'workloads'));
    for (const selector of ['small', 'havit']) {
        const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'workloads', `${selector}.json`), 'utf8'));
        const workspace = path.join(stage, template.workspace);
        const webRoot = path.join(workspace, 'wwwroot');
        const entry = manifest.workloads[selector];
        if (template.assembly !== entry.assembly)
            throw Error(`Unexpected ${selector} app identity; stop/source expectations require review.`);
        copy(config.paths[`${selector}WebRoot`], webRoot);
        for (const asset of manifest.hosts[host.key].native.files) {
            const target = path.join(webRoot, '_framework', path.basename(asset.path));
            if (fs.existsSync(target) && sha256(target) !== asset.sha256) {
                throw Error(`Conflicting supplied ${selector} native asset ${asset.path}; no mixed cohort overlay.`);
            }
            if (!fs.existsSync(target)) copy(path.join(config.paths.nativeAssets, asset.path), target);
        }
        copy(config.paths[`${selector}Handoff`], path.join(workspace, 'runtime-handoff.json'));
        const url = `http://127.0.0.1:${config.ports[selector]}${selector === 'small' ? '/index.html' : '/components/HxGrid'}`;
        template.url = url;
        template.server =
            selector === 'small'
                ? {
                      command: config.executables.dotnetServe,
                      args: [
                          '-a',
                          '127.0.0.1',
                          '-p',
                          String(config.ports.small),
                          '-d',
                          '${workspace}/wwwroot',
                          '--mime',
                          '.wasm=application/wasm',
                          '--mime',
                          '.mjs=text/javascript',
                          '-h',
                          'Timing-Allow-Origin:*',
                      ],
                  }
                : {
                      command: process.execPath,
                      args: [
                          path.join(__dirname, 'serveHavit.mjs'),
                          config.paths.havitServerModule,
                          '${workspace}/wwwroot',
                          String(config.ports.havit),
                      ],
                  };
        if (selector === 'havit') {
            const hashIndex = `${url}#header-filtering`.indexOf('#');
            for (const stop of template.stops.filter((s) => s.line === 19 || s.line === 20)) {
                stop.localValues = { hashIndex: String(hashIndex) };
            }
            if (template.extendedInspection) {
                template.extendedInspection.callerLocalContains = { url: `${url}#header-filtering` };
            }
        }
        template.versions = manifest.versions;
        fs.writeFileSync(path.join(stage, 'workloads', `${selector}.json`), JSON.stringify(template, null, 2));
        fs.mkdirSync(path.join(workspace, '.vscode'));
        const launch = {
            name:
                selector === 'small'
                    ? 'Existing CoreCLR browser sample'
                    : 'Havit synchronous URL-helper debugger baseline',
            type: 'blazorwasm',
            request: 'attach',
            trace: true,
            projectPath: path.join(workspace, `${entry.assembly}.csproj`),
            cwd: workspace,
            url,
            webRoot,
            browser: config.browserType,
            browserConfig: {
                runtimeExecutable: config.executables.browser,
                userDataDir: path.join(stage, `${selector}-browser-profile`),
                runtimeArgs: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
            },
            dotNetConfig: {
                program: path.join(webRoot, entry.appDll),
                debugServer: config.ports.dap,
                sourceFileMap: config.sourceMaps[selector],
                justMyCode: true,
                coreClrMobileDebuggerOptions: { assetsPath: path.join(webRoot, '_framework') },
                logging: {
                    diagnosticsLog: { protocolMessages: true },
                    ...(config.diagnosticLogging ? { elapsedTiming: true } : {}),
                },
            },
        };
        fs.writeFileSync(
            path.join(workspace, `${entry.assembly}.csproj`),
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net11.0</TargetFramework><OutputType>Exe</OutputType><UseCoreCLR>true</UseCoreCLR><UseMonoRuntime>false</UseMonoRuntime></PropertyGroup></Project>\n'
        );
        fs.writeFileSync(
            path.join(workspace, '.vscode', 'launch.json'),
            JSON.stringify({ version: '0.2.0', configurations: [launch] }, null, 2)
        );
    }
    copy(config.paths.extensionDependencies, path.join(stage, 'extensions'));
    fs.writeFileSync(
        path.join(stage, 'stage-manifest.json'),
        JSON.stringify(
            {
                cohortId: manifest.cohortId,
                host,
                sourceManifestSha256: sha256(config.manifest),
                createdAt: new Date().toISOString(),
                artifactRoot: stage,
                noSymlinks: true,
            },
            null,
            2
        )
    );
    return stage;
}
module.exports = { stageExtension };
