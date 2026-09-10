'use strict';

/**
 * The Node-RED consumer path, end to end.
 *
 * Everything else in this suite proves the fix at the library seam: buildUrlWithQuery directly, or
 * callEndpoint with fetch stubbed. Neither exercises the way this package is actually used. The
 * primary consumer is the Node-RED node in node.js, and the bug's second facet lives specifically
 * there:
 *
 *   node.html renders EVERY query parameter as a plain text field. examples.json confirms it - the
 *   editor emits `storedParams` entries of the shape { camelCaseName, value, type: 'str' }, and the
 *   type is 'str' even for parameters endpoints.json declares `"type": "array"` (see the
 *   getOrganizationNetworks nodes in examples/examples.json, where `tags` and `productTypes` are
 *   both `str`). So a user filtering devices by one product type types `appliance` into a box and
 *   the node hands callEndpoint the SCALAR STRING 'appliance', never ['appliance'].
 *
 * That is why requirement 2.3 exists, and why the fix could not be `Array.isArray`-driven: at this
 * point in the call there is no array to detect. Rule 4 (declared type is 'array' -> one bracketed
 * pair per element, a scalar counting as one element) is what makes the text-field path work.
 *
 * WHAT THE NODE ACTUALLY DOES WITH A STORED PARAMETER - observed, not assumed
 *
 * node.js builds `storedParamValsMap` and `storedParamTypeMap` from `node.storedParams` keyed on
 * `camelCaseName`, then for each path/query parameter of the operation:
 *
 *     var nodeParam     = storedParamValsMap[paramName] || RED.util.getMessageProperty(msg, paramName);
 *     var nodeParamType = storedParamTypeMap[paramName] || RED.util.getMessageProperty(msg, paramName);
 *     if (nodeParamType === 'str') { callParams[paramName] = nodeParam || undefined; }
 *     else                         { callParams[paramName] = RED.util.getMessageProperty(msg, paramName); }
 *
 * Three consequences worth recording, all confirmed by the tests below:
 *
 *   1. With type 'str' the stored value reaches callEndpoint UNCONVERTED. There is no split on ','
 *      and no JSON parsing, so a declared array parameter arrives as a bare scalar string. The node
 *      does not coerce it into an array anywhere.
 *   2. `storedParamValsMap[paramName] || msg[paramName]` means an EMPTY text field falls through to
 *      the msg property, so `msg.productTypes = ['appliance','switch']` is a genuine way for a real
 *      array to reach the same code path. Both shapes are covered.
 *   3. `nodeParam || undefined` is a truthiness filter, so an untouched (empty-string) field is
 *      dropped before it ever reaches the serializer. That is why unfilled fields produce neither
 *      `perPage=` nor `productTypes%5B%5D=`. It also means the node cannot express a deliberate
 *      `false`, `0` or `''` for a query parameter - a pre-existing node.js characteristic, outside
 *      this fix's scope (the fix is confined to lib.js) and noted here rather than worked around.
 *
 * No network traffic is generated: global.fetch is stubbed and the API key is a placeholder.
 *
 * Validates: Requirements 2.3, 2.5, 3.10
 */

var assert = require('assert');
var helper = require('node-red-node-test-helper');
var node = require('../node.js');
var lib = require('../lib.js');
var fetchStub = require('./helpers/fetchStub');

helper.init(require.resolve('node-red'));

var MerakiDashboardApi = lib.MerakiDashboardApi;

var HOST = 'https://api.meraki.com/api/v1';
var ORG_ID = '715461';

// Placeholder only. fetch is stubbed, so nothing leaves the process and no real key is involved.
var PLACEHOLDER_KEY = 'not-a-real-key';

var CREDENTIALS = { svc: { secureApiKeyValue: PLACEHOLDER_KEY } };

/**
 * Build the `storedParams` array the Node-RED editor would emit for an operation.
 *
 * Derived from endpoints.json rather than hardcoded, and typed 'str' for every field, which is what
 * examples.json shows the generated editor doing - including for declared arrays. Fields not named
 * in `values` get '', the untouched-text-field state.
 *
 * @param {string} operationId
 * @param {object} values - camelCaseName -> text-field contents
 * @returns {Array<{camelCaseName: string, value: *, type: string}>}
 */
function storedParamsFor(operationId, values) {
    var endpoint = MerakiDashboardApi.getEndpoint(operationId);
    assert.ok(endpoint, 'operation not present in endpoints.json: ' + operationId);

    return endpoint.params.filter(function (paramDef) {
        return paramDef.in === 'path' || paramDef.in === 'query';
    }).map(function (paramDef) {
        var hasValue = Object.prototype.hasOwnProperty.call(values, paramDef.name);
        return {
            camelCaseName: paramDef.name,
            value: hasValue ? values[paramDef.name] : '',
            type: 'str'
        };
    });
}

/**
 * A flow with the node wired to a helper node, plus the service config node it needs.
 *
 * Without a service config node carrying a host, node.js errors with
 * 'Host in configuration node is not specified.' before any request is built - the third existing
 * node_spec.js test covers that config node's shape.
 *
 * @param {string} operationId
 * @param {object} values - text-field contents by camelCaseName
 * @returns {Array<object>}
 */
function flowFor(operationId, values) {
    return [
        {
            id: 'n1',
            type: 'meraki-dashboard-api-v1',
            name: operationId,
            service: 'svc',
            method: operationId,
            storedParams: storedParamsFor(operationId, values),
            wires: [['n2']]
        },
        { id: 'n2', type: 'helper' },
        {
            id: 'svc',
            type: 'meraki-dashboard-api-v1-service',
            host: HOST,
            secureApiKeyHeaderOrQueryName: 'X-Cisco-Meraki-API-Key',
            secureApiKeyIsQuery: false
        }
    ];
}

/**
 * Load a flow, send one message in, and resolve when the node emits its result.
 *
 * A node.error() rejects instead, so a misconfigured flow surfaces as the node's own message rather
 * than as an opaque timeout.
 *
 * @param {Array<object>} flow
 * @param {object} msg
 * @returns {Promise<object>} the message the node sent downstream
 */
function runFlow(flow, msg) {
    return new Promise(function (resolve, reject) {
        helper.load(node, flow, CREDENTIALS, function () {
            var n1 = helper.getNode('n1');
            var n2 = helper.getNode('n2');

            n1.on('call:error', function (call) {
                reject(new Error('node reported an error: ' + call.firstArg));
            });
            n2.on('input', function (sent) {
                resolve(sent);
            });

            n1.receive(msg);
        });
    });
}

/**
 * Exact key -> values view of a URL's query string.
 *
 * URLSearchParams percent-decodes keys on parse, so a `%5B%5D` suffix reads back as a literal `[]`.
 * Exact-key getAll() is what makes bracketed and bare unambiguously distinguishable; substring
 * matching on the raw URL cannot, since one name can be a suffix of another.
 *
 * @param {string} url
 * @returns {URLSearchParams}
 */
function queryOf(url) {
    return new URL(url).searchParams;
}

/**
 * Assert a name reached the wire in the bracket-suffixed form the live API accepts, and in no other
 * form.
 *
 * @param {string} url
 * @param {string} name - unbracketed parameter name
 * @param {Array} elements - expected element values, in caller order
 */
function assertBracketed(url, name, elements) {
    var params = queryOf(url);

    assert.deepStrictEqual(
        params.getAll(name + '[]'),
        elements.map(String),
        name + ' should emit one bracketed pair per element, in order: ' + url
    );
    assert.deepStrictEqual(
        params.getAll(name),
        [],
        'the bare form the API rejects with 400 must not appear for ' + name + ': ' + url
    );
    assert.ok(
        url.indexOf(name + '%5B%5D=') !== -1,
        'suffix should reach the wire as %5B%5D: ' + url
    );
    assert.strictEqual(
        url.indexOf('%5B%5D%5B%5D'),
        -1,
        'never double-bracketed - the API rejects that too: ' + url
    );
}

describe('Node-RED consumer path: declared arrays from text fields (2.3, 2.5, 3.10)', function () {

    var capture;

    beforeEach(function () {
        capture = fetchStub.install();
    });

    afterEach(function (done) {
        fetchStub.restore();
        helper.unload().then(function () {
            done();
        });
    });

    // -----------------------------------------------------------------------------------
    // The real-world case: a text field, therefore a scalar, for a declared array.
    // -----------------------------------------------------------------------------------
    describe('a scalar text-field value for a declared array parameter', function () {

        it('is what the editor actually produces - productTypes is a declared array typed str', function () {
            // Both halves of the premise, verified rather than asserted in prose: endpoints.json
            // declares productTypes an array, and the storedParams the editor emits type it 'str'.
            var paramDef = MerakiDashboardApi.getEndpoint('getOrganizationDevices').params
                .filter(function (p) { return p.in === 'query' && p.name === 'productTypes'; })[0];
            assert.ok(paramDef, 'productTypes should be a query parameter of getOrganizationDevices');
            assert.strictEqual(paramDef.type, 'array', 'productTypes should be declared type array');

            var stored = storedParamsFor('getOrganizationDevices', { productTypes: 'appliance' })
                .filter(function (p) { return p.camelCaseName === 'productTypes'; })[0];
            assert.strictEqual(stored.type, 'str', 'the editor types even a declared array as a str field');
            assert.strictEqual(typeof stored.value, 'string', 'a text field yields a string, not an array');
        });

        it('reaches the wire bracketed: productTypes%5B%5D=appliance (2.3)', function () {
            var flow = flowFor('getOrganizationDevices', {
                organizationId: ORG_ID,
                productTypes: 'appliance'
            });

            return runFlow(flow, { payload: {} }).then(function () {
                assert.strictEqual(capture.count, 1, 'exactly one request should have been made');
                assert.strictEqual(
                    capture.url,
                    HOST + '/organizations/' + ORG_ID + '/devices?productTypes%5B%5D=appliance',
                    'the whole URL, so path substitution is covered too'
                );
                assertBracketed(capture.url, 'productTypes', ['appliance']);
            });
        });

        it('brackets every declared array on the call while leaving declared scalars bare (2.3, 3.1)', function () {
            // Three text fields: two declared arrays and one declared integer. The type-driven rule
            // has to split them, and the scalar's pre-fix bare form has to survive.
            var flow = flowFor('getOrganizationDevices', {
                organizationId: ORG_ID,
                productTypes: 'appliance',
                tags: 'branch-office',
                perPage: '100'
            });

            return runFlow(flow, { payload: {} }).then(function () {
                assert.strictEqual(capture.count, 1);
                var params = queryOf(capture.url);

                assertBracketed(capture.url, 'productTypes', ['appliance']);
                assertBracketed(capture.url, 'tags', ['branch-office']);

                assert.deepStrictEqual(
                    params.getAll('perPage'),
                    ['100'],
                    'perPage is declared integer and must stay bare: ' + capture.url
                );
                assert.deepStrictEqual(
                    params.getAll('perPage[]'),
                    [],
                    'perPage must never be bracketed: ' + capture.url
                );
            });
        });

        it('omits untouched text fields entirely - no empty bracketed pair (3.3, 3.4)', function () {
            // node.js applies `nodeParam || undefined`, so '' never reaches the serializer. Worth
            // asserting from the consumer end: an empty field must not turn into `macs%5B%5D=`.
            var flow = flowFor('getOrganizationDevices', {
                organizationId: ORG_ID,
                productTypes: 'appliance'
            });

            return runFlow(flow, { payload: {} }).then(function () {
                var params = queryOf(capture.url);
                var names = [];
                params.forEach(function (value, key) {
                    names.push(key);
                });

                assert.deepStrictEqual(
                    names,
                    ['productTypes[]'],
                    'only the filled field should appear in the query string: ' + capture.url
                );
            });
        });

        it('percent-encodes the element while keeping the accepted suffix form (2.6)', function () {
            // A tag with a space and a colon, typed into the box exactly as a user would.
            var flow = flowFor('getOrganizationDevices', {
                organizationId: ORG_ID,
                tags: 'branch office:north'
            });

            return runFlow(flow, { payload: {} }).then(function () {
                assert.strictEqual(
                    capture.url,
                    HOST + '/organizations/' + ORG_ID + '/devices?tags%5B%5D=branch+office%3Anorth',
                    'element encoded, suffix left as %5B%5D'
                );
                assertBracketed(capture.url, 'tags', ['branch office:north']);
            });
        });
    });

    // -----------------------------------------------------------------------------------
    // The other shape that reaches the same code: an empty text field falling through to msg.
    // -----------------------------------------------------------------------------------
    describe('an array supplied via msg, which an empty text field falls through to', function () {

        it('brackets each element in order (2.1 on the consumer path)', function () {
            var flow = flowFor('getOrganizationDevices', { organizationId: ORG_ID });

            return runFlow(flow, {
                payload: {},
                productTypes: ['appliance', 'switch']
            }).then(function () {
                assert.strictEqual(capture.count, 1);
                assert.strictEqual(
                    capture.url,
                    HOST + '/organizations/' + ORG_ID +
                    '/devices?productTypes%5B%5D=appliance&productTypes%5B%5D=switch'
                );
                assertBracketed(capture.url, 'productTypes', ['appliance', 'switch']);
            });
        });

        it('is overridden by a filled text field, which then still brackets', function () {
            // `storedParamValsMap[name] || msg[name]` - a non-empty field wins. Recording the
            // precedence because it determines which value the assertion above is really about.
            var flow = flowFor('getOrganizationDevices', {
                organizationId: ORG_ID,
                productTypes: 'wireless'
            });

            return runFlow(flow, {
                payload: {},
                productTypes: ['appliance', 'switch']
            }).then(function () {
                assertBracketed(capture.url, 'productTypes', ['wireless']);
            });
        });
    });

    // -----------------------------------------------------------------------------------
    // A required declared array, driven from a text field. Pre-fix this operation had no
    // callable form at all.
    // -----------------------------------------------------------------------------------
    describe('a required declared array from a text field', function () {

        it('makes getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval callable from the node (2.3, 2.4)', function () {
            var operationId = 'getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval';
            var flow = flowFor(operationId, {
                organizationId: ORG_ID,
                serials: 'Q2XX-XXXX-XXXX'
            });

            return runFlow(flow, { payload: {} }).then(function () {
                assert.strictEqual(capture.count, 1);
                assertBracketed(capture.url, 'serials', ['Q2XX-XXXX-XXXX']);
            });
        });
    });
});

describe('$queryParameters end to end through callEndpoint (2.5, 3.6)', function () {

    // The escape hatch cannot be reached from the node's editor form: node.js only ever populates
    // callParams with names the operation declares, so $queryParameters is a library-level entry
    // point. It is exercised here directly for that reason. lib_decision_table_spec.js covers WHICH
    // rule fires for each variant; these two are the end-to-end behaviors task 8 calls for.

    var capture;
    var api;

    beforeEach(function () {
        capture = fetchStub.install();
        api = new MerakiDashboardApi(HOST);
        api.setApiKey(PLACEHOLDER_KEY, 'X-Cisco-Meraki-API-Key', false);
    });

    afterEach(function () {
        fetchStub.restore();
    });

    it('an unbracketed array gets bracketed (2.5)', function () {
        return api.callEndpoint('getOrganizationDevices', {
            organizationId: ORG_ID,
            $queryParameters: { networkIds: ['N_1', 'N_2'] }
        }).then(function () {
            assert.strictEqual(capture.count, 1);
            assertBracketed(capture.url, 'networkIds', ['N_1', 'N_2']);
        });
    });

    it('an unbracketed array under a name the operation does not declare gets bracketed too (2.5)', function () {
        // No declared type anywhere for this key, so the bracketing cannot be coming from
        // endpoints.json. This is the escape hatch in its purest form.
        var operationId = 'getOrganizationDevices';
        var undeclared = 'organizationIds';
        var declaredQueryNames = MerakiDashboardApi.getEndpoint(operationId).params
            .filter(function (p) { return p.in === 'query'; })
            .map(function (p) { return p.name; });
        assert.strictEqual(
            declaredQueryNames.indexOf(undeclared),
            -1,
            undeclared + ' must not be a declared query parameter of ' + operationId
        );

        var parameters = { organizationId: ORG_ID, $queryParameters: {} };
        parameters.$queryParameters[undeclared] = ['715461', '123456'];

        return api.callEndpoint(operationId, parameters).then(function () {
            assertBracketed(capture.url, undeclared, ['715461', '123456']);
        });
    });

    it('a pre-bracketed key stays single-bracketed (3.6)', function () {
        // The workaround callers already use. Double-bracketing would break exactly the people who
        // worked around the bug: the live API returns 400 "Each element in 'productTypes' must be a
        // string" for productTypes[][].
        return api.callEndpoint('getOrganizationDevices', {
            organizationId: ORG_ID,
            $queryParameters: { 'productTypes[]': ['appliance', 'switch'] }
        }).then(function () {
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID +
                '/devices?productTypes%5B%5D=appliance&productTypes%5B%5D=switch'
            );
            assertBracketed(capture.url, 'productTypes', ['appliance', 'switch']);
        });
    });

    it('a pre-bracketed key with a scalar value stays single-bracketed as well (3.6)', function () {
        return api.callEndpoint('getOrganizationDevices', {
            organizationId: ORG_ID,
            $queryParameters: { 'productTypes[]': 'appliance' }
        }).then(function () {
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID + '/devices?productTypes%5B%5D=appliance'
            );
        });
    });
});

describe('Node-RED consumer path: Meraki error-body surfacing on a 400', function () {

    // lib.js throws an Error with the parsed body on error.body ({ errors: [...] } for Meraki
    // validation failures, NO message key) and the response on error.response.statusCode. The
    // node.js catch block used to check only error.body.message, so it never matched and the debug
    // pane showed just "Request failed with status code 400" with no reason. This drives the node
    // through a real 400 and asserts the human-readable message now carries both the Meraki text
    // and the HTTP status.

    var MERAKI_ERROR_TEXT =
        "Each element in 'productTypes' must be one of: 'appliance', 'camera', ...";

    beforeEach(function () {
        // Stub fetch to reject with a 400 whose JSON body is Meraki's { errors: [...] } shape.
        fetchStub.install({
            status: 400,
            contentType: 'application/json',
            json: { errors: [MERAKI_ERROR_TEXT] }
        });
    });

    afterEach(function (done) {
        fetchStub.restore();
        helper.unload().then(function () {
            done();
        });
    });

    it('surfaces the errors-array text and the HTTP status to node.error', function () {
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: 'not-a-real-type'
        });

        return new Promise(function (resolve, reject) {
            helper.load(node, flow, CREDENTIALS, function () {
                var n1 = helper.getNode('n1');
                var n2 = helper.getNode('n2');

                n1.on('call:error', function (call) {
                    resolve(String(call.firstArg));
                });
                n2.on('input', function () {
                    reject(new Error('node sent downstream instead of erroring on a 400'));
                });

                n1.receive({ payload: {} });
            });
        }).then(function (message) {
            assert.ok(
                message.indexOf("Each element in 'productTypes' must be one of") !== -1,
                'the Meraki errors-array text should reach the debug pane: ' + message
            );
            assert.ok(
                message.indexOf('HTTP 400') !== -1,
                'the HTTP status code should be prefixed: ' + message
            );
        });
    });
});

describe('Node-RED consumer path: a JSON array literal typed into the config field', function () {

    // node.js used to pass the config field's text through verbatim for query parameters, so typing
    // ["appliance","camera"] into the productTypes box sent that literal string, which lib.js rule 4
    // brackets as ONE element - productTypes%5B%5D=%5B%22appliance%22... - and Meraki answers 400.
    // Passing a real array via msg.productTypes already worked. The node now parses a JSON array
    // literal out of the field so it accepts the same shape the msg property can carry.
    //
    // Scope of the parse, asserted below: keyed on endpoints.json's declared "type": "array", only
    // for string values, only when the trimmed text starts with '['. No comma splitting. Malformed
    // JSON errors rather than going out verbatim.

    var capture;

    beforeEach(function () {
        capture = fetchStub.install();
    });

    afterEach(function (done) {
        fetchStub.restore();
        helper.unload().then(function () {
            done();
        });
    });

    it('parses a JSON array literal into one bracketed pair per element', function () {
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: '["appliance","camera"]'
        });

        return runFlow(flow, { payload: {} }).then(function () {
            assert.strictEqual(capture.count, 1);
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID +
                '/devices?productTypes%5B%5D=appliance&productTypes%5B%5D=camera'
            );
            assertBracketed(capture.url, 'productTypes', ['appliance', 'camera']);
        });
    });

    it('leaves a bare scalar in the field working as before - exactly one bracketed pair', function () {
        // Regression guard on today's behavior: the text does not start with '[', so no parse runs
        // and lib.js rule 4 still treats the scalar as a one-element array.
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: 'appliance'
        });

        return runFlow(flow, { payload: {} }).then(function () {
            assert.strictEqual(capture.count, 1);
            assert.deepStrictEqual(
                queryOf(capture.url).getAll('productTypes[]'),
                ['appliance'],
                'a scalar must still produce exactly one element: ' + capture.url
            );
            assertBracketed(capture.url, 'productTypes', ['appliance']);
        });
    });

    it('leaves a real array from a msg property untouched', function () {
        // The path the user verified manually. `typeof resolved === 'string'` gates the parse, so an
        // array arriving from msg never enters it.
        var flow = flowFor('getOrganizationDevices', { organizationId: ORG_ID });

        return runFlow(flow, {
            payload: {},
            productTypes: ['appliance', 'camera']
        }).then(function () {
            assert.strictEqual(capture.count, 1);
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID +
                '/devices?productTypes%5B%5D=appliance&productTypes%5B%5D=camera'
            );
            assertBracketed(capture.url, 'productTypes', ['appliance', 'camera']);
        });
    });

    it('tolerates surrounding whitespace around the literal', function () {
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: '  ["appliance"]  '
        });

        return runFlow(flow, { payload: {} }).then(function () {
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID + '/devices?productTypes%5B%5D=appliance'
            );
        });
    });

    it('omits the parameter entirely for an empty JSON array (lib.js rule 2)', function () {
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: '[]'
        });

        return runFlow(flow, { payload: {} }).then(function () {
            assert.strictEqual(
                capture.url,
                HOST + '/organizations/' + ORG_ID + '/devices',
                'an empty array is dropped, leaving the bare base URL with no "?": ' + capture.url
            );
            var params = queryOf(capture.url);
            assert.deepStrictEqual(params.getAll('productTypes'), []);
            assert.deepStrictEqual(params.getAll('productTypes[]'), []);
        });
    });

    it('errors naming the parameter on a malformed JSON array, and makes no request', function () {
        // Forwarding `["appliance"` verbatim is what produced the unexplained 400. Failing loudly is
        // the point, so the error text has to name the parameter and nothing may reach the wire.
        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            productTypes: '["appliance"'
        });

        return new Promise(function (resolve, reject) {
            helper.load(node, flow, CREDENTIALS, function () {
                var n1 = helper.getNode('n1');
                var n2 = helper.getNode('n2');

                n1.on('call:error', function (call) {
                    resolve(String(call.firstArg));
                });
                n2.on('input', function () {
                    reject(new Error('node sent downstream instead of erroring on malformed JSON'));
                });

                n1.receive({ payload: {} });
            });
        }).then(function (message) {
            assert.ok(
                message.indexOf('productTypes') !== -1,
                'the error must name the offending parameter: ' + message
            );
            assert.strictEqual(
                capture.count,
                0,
                'no HTTP request may be made when the literal cannot be parsed'
            );
        });
    });

    it('leaves a parameter that is not declared an array untouched', function () {
        // `name` on this same operation is declared "type": "string" in endpoints.json, so the parse
        // must not run: the literal text goes out as-is, unparsed and unbracketed.
        var paramDef = MerakiDashboardApi.getEndpoint('getOrganizationDevices').params
            .filter(function (p) { return p.in === 'query' && p.name === 'name'; })[0];
        assert.ok(paramDef, 'name should be a query parameter of getOrganizationDevices');
        assert.strictEqual(paramDef.type, 'string', 'name should be declared type string');

        var flow = flowFor('getOrganizationDevices', {
            organizationId: ORG_ID,
            name: '["a"]'
        });

        return runFlow(flow, { payload: {} }).then(function () {
            var params = queryOf(capture.url);
            assert.deepStrictEqual(
                params.getAll('name'),
                ['["a"]'],
                'the literal string must survive verbatim: ' + capture.url
            );
            assert.deepStrictEqual(
                params.getAll('name[]'),
                [],
                'a declared string must never be bracketed: ' + capture.url
            );
        });
    });
});

describe('Node-RED consumer path: object elements in an array parameter surface as a node error', function () {

    // This is the consumer-facing half of the rule 4 non-scalar change, and the reason
    // request() converts buildUrlWithQuery's throw into a promise rejection.
    //
    // lib.js rule 4 refuses to serialize object elements under a declared-array parameter: the
    // query-string wire format for them is unspecified by the OpenAPI spec and unverified against
    // the live API, so it throws instead of emitting `ranges%5B%5D=%5Bobject+Object%5D`.
    // buildUrlWithQuery is SYNCHRONOUS, so if request() let that throw escape, it would bypass the
    // .catch() in node.js entirely and come out of the Node-RED input handler - the user would get
    // no debug-pane message at all. request() wraps the call and rejects instead, which keeps the
    // node's existing catch block in play.
    //
    // The route in below is the realistic one: node.js parses a JSON array literal typed into the
    // config field, so `[{"startTime":...}]` becomes a genuine array of objects before it ever
    // reaches lib.js. A msg property carrying the same array is covered too.

    var OPERATION = 'getOrganizationCameraDetectionsHistoryByBoundaryByInterval';
    var RANGE_LITERAL = '[{"startTime":"2026-01-01T00:00:00Z","endTime":"2026-01-02T00:00:00Z","interval":3600}]';

    var capture;

    beforeEach(function () {
        capture = fetchStub.install();
    });

    afterEach(function (done) {
        fetchStub.restore();
        helper.unload().then(function () {
            done();
        });
    });

    /**
     * Load a flow, send one message, and resolve with the node.error text.
     *
     * The inverse of runFlow: here an error is the expected outcome and a downstream send is the
     * failure. If the throw were escaping synchronously, neither would happen and this would time
     * out - which is exactly the regression this guards.
     *
     * @param {Array<object>} flow
     * @param {object} msg
     * @returns {Promise<string>} the first argument node.error was called with
     */
    function runFlowExpectingError(flow, msg) {
        return new Promise(function (resolve, reject) {
            helper.load(node, flow, CREDENTIALS, function () {
                var n1 = helper.getNode('n1');
                var n2 = helper.getNode('n2');

                n1.on('call:error', function (call) {
                    resolve(String(call.firstArg));
                });
                n2.on('input', function () {
                    reject(new Error('node sent downstream instead of erroring on object elements'));
                });

                n1.receive(msg);
            });
        });
    }

    it('reports a message naming the parameter, and makes no request, for a JSON array of objects in the field', function () {
        var flow = flowFor(OPERATION, {
            organizationId: ORG_ID,
            boundaryIds: 'boundary-1',
            ranges: RANGE_LITERAL
        });

        return runFlowExpectingError(flow, { payload: {} }).then(function (message) {
            assert.ok(
                message.indexOf('ranges') !== -1,
                'the error must name the offending parameter: ' + message
            );
            assert.ok(
                /scalar/.test(message),
                'the error should say what is required instead: ' + message
            );
            assert.strictEqual(
                capture.count,
                0,
                'nothing may reach the wire - the old behavior sent a malformed URL, this sends nothing'
            );
        });
    });

    it('reports the same message for an array of objects arriving on a msg property', function () {
        var flow = flowFor(OPERATION, {
            organizationId: ORG_ID,
            boundaryIds: 'boundary-1'
        });

        return runFlowExpectingError(flow, {
            payload: {},
            ranges: [{ startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z', interval: 3600 }]
        }).then(function (message) {
            assert.ok(message.indexOf('ranges') !== -1, 'the error must name the parameter: ' + message);
            assert.strictEqual(capture.count, 0, 'no HTTP request may be made');
        });
    });
});
