/**
 * Downloads the latest Meraki OpenAPI spec (v3) from GitHub and generates
 * an updated endpoints.json with all available API endpoints.
 * 
 * Usage: node update_from_openapi.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SPEC_URL = 'https://raw.githubusercontent.com/meraki/openapi/master/openapi/spec3.json';
const OUTPUT_PATH = path.join(__dirname, 'endpoints.json');

function download(url) {
    return new Promise((resolve, reject) => {
        console.log('Downloading OpenAPI 3.0 spec...');
        let data = '';
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parseSpec(specJson) {
    const spec = JSON.parse(specJson);
    console.log('OpenAPI version:', spec.openapi);
    console.log('API version:', spec.info.version);
    console.log('Parsing paths...');

    const endpoints = [];

    for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(pathObj)) {
            // Skip non-HTTP-method keys (e.g. shared "parameters")
            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

            const operationId = operation.operationId;
            if (!operationId) continue;

            // Extract path and query parameters
            const params = [];
            if (operation.parameters) {
                for (const param of operation.parameters) {
                    if (param.in === 'path' || param.in === 'query') {
                        // In OpenAPI 3, type is nested inside "schema"
                        const paramType = (param.schema && param.schema.type) || 'string';
                        params.push({
                            name: param.name,
                            in: param.in,
                            type: paramType,
                            required: param.in === 'path' ? true : (param.required || false)
                        });
                    }
                }
            }

            // Extract request body (OpenAPI 3 uses "requestBody" instead of in-body parameters)
            let bodyExample = undefined;
            if (operation.requestBody) {
                const content = operation.requestBody.content;
                const jsonContent = content && content['application/json'];

                // Add a body parameter entry
                params.push({
                    name: operationId,
                    in: 'body',
                    type: 'object',
                    required: operation.requestBody.required || false
                });

                // Extract example from schema if available
                if (jsonContent && jsonContent.schema && jsonContent.schema.example) {
                    bodyExample = jsonContent.schema.example;
                }
            }

            // Extract tags and summary
            const tags = operation.tags || [];
            const summary = operation.summary || operation.description || operationId;

            const endpoint = {
                operationId,
                method: method.toUpperCase(),
                path: pathStr,
                params,
                tags,
                summary
            };

            if (bodyExample) {
                endpoint.bodyExample = bodyExample;
            }

            endpoints.push(endpoint);
        }
    }

    return { endpoints, version: spec.info.version };
}

async function main() {
    try {
        const specJson = await download(SPEC_URL);
        console.log('Downloaded (' + (specJson.length / 1024 / 1024).toFixed(1) + ' MB)');

        const { endpoints, version } = parseSpec(specJson);

        // Sort endpoints by path then method for consistency
        endpoints.sort((a, b) => {
            if (a.path < b.path) return -1;
            if (a.path > b.path) return 1;
            const methodOrder = { GET: 0, POST: 1, PUT: 2, DELETE: 3, PATCH: 4 };
            return (methodOrder[a.method] || 5) - (methodOrder[b.method] || 5);
        });

        // Write output
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(endpoints, null, 2), 'utf8');

        // Stats
        const methods = {};
        endpoints.forEach(ep => {
            methods[ep.method] = (methods[ep.method] || 0) + 1;
        });

        console.log('\n=== Results ===');
        console.log('API Version: ' + version);
        console.log('Total endpoints: ' + endpoints.length);
        console.log('By method:', JSON.stringify(methods));
        console.log('Written to: ' + OUTPUT_PATH);

        // Compare with previous if a backup exists
        const prevPath = OUTPUT_PATH + '.bak';
        if (fs.existsSync(prevPath)) {
            const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
            const prevIds = new Set(prev.map(e => e.operationId));
            const newIds = new Set(endpoints.map(e => e.operationId));
            const added = endpoints.filter(e => !prevIds.has(e.operationId));
            const removed = prev.filter(e => !newIds.has(e.operationId));
            console.log('\nNew endpoints added: ' + added.length);
            console.log('Endpoints removed: ' + removed.length);
            if (added.length > 0 && added.length <= 20) {
                console.log('Added:', added.map(e => e.operationId).join(', '));
            }
        }

        console.log('\nDone! Run "node build.js" to update node.html');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

main();
