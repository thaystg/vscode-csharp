/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'net';
import * as path from 'path';
import type { ProjectDebugInformation } from '../../../shared/IWorkspaceDebugInformationProvider';

export function getCoreClrBrowserProgram(
    projects: readonly Pick<ProjectDebugInformation, 'projectPath' | 'outputPath'>[] | undefined,
    projectPath: string
): string {
    const normalize = (value: string) =>
        process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const matches = projects?.filter((project) => normalize(project.projectPath) === normalize(projectPath));
    if (matches?.length !== 1 || !path.isAbsolute(matches[0].outputPath)) {
        throw new Error(
            `Could not resolve a unique managed output for WebAssembly project '${projectPath}'. ` +
                'Load and build that client project before debugging.'
        );
    }
    return matches[0].outputPath;
}

export async function findBrowserDebugPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a browser debugging port.')));
                return;
            }
            server.close((error) => (error ? reject(error) : resolve(address.port)));
        });
    });
}

export function parseBrowserBridgeReady(body: unknown, expectedBrowserPort: number): string {
    if (!body || typeof body !== 'object') {
        throw new Error('The native browser bridge did not return readiness information.');
    }
    if (!('success' in body) || body.success !== true) {
        throw new Error(
            'error' in body && typeof body.error === 'string'
                ? body.error
                : 'The native browser bridge failed to start.'
        );
    }
    if (
        !('browserPort' in body) ||
        body.browserPort !== expectedBrowserPort ||
        !('inspectUri' in body) ||
        typeof body.inspectUri !== 'string'
    ) {
        throw new Error('The native browser bridge returned an unexpected endpoint.');
    }
    const endpoint = new URL(body.inspectUri);
    if (
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.username ||
        endpoint.password ||
        !endpoint.port ||
        endpoint.pathname !== '/ws-proxy' ||
        endpoint.searchParams.get('browser') !== '{browserInspectUri}' ||
        endpoint.hash
    ) {
        throw new Error('The native browser bridge returned an invalid loopback relay URI.');
    }
    return body.inspectUri;
}
