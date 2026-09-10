'use strict';

/**
 * Property 1: Bug Condition - Declared array query parameters are bracket-suffixed.
 *
 * THIS FILE IS EXPECTED TO FAIL ON UNFIXED CODE. The failures are the point: they are the
 * counterexamples that confirm the root cause before any production code is touched. Once
 * the fix lands (task 4), the same file - unmodified - becomes the fix-verification suite.
 *
 * Bug_Condition (from design.md):
 *
 *   isBugCondition(X) = X.declaredType === 'array'
 *                   AND X.value is neither null nor undefined
 *                   AND NOT (isArray(X.value) AND X.value.length === 0)
 *                   AND NOT X.name.endsWith('[]')
 *
 * Expected_Behavior: one `name[]=element` pair per element in the caller's order, each element
 * percent-encoded by URLSearchParams, a scalar counted as a single element. URLSearchParams
 * emits the `[]` suffix as `%5B%5D`, and the live-API evidence table in design.md shows Meraki
 * decodes that form and honours the filter identically to a literal `[]`.
 *
 * Scoped PBT: the defect is fully deterministic - it depends only on the declared type and the
 * value shape, not on the particular characters in the value - so the property is scoped to the
 * concrete declared-array cases below. The wide generation domain (all 94 declared-array names in
 * endpoints.json, endpoint-wide sweep) belongs to task 6.
 *
 * Root-cause discrimination: every counterexample below is expected to show the CORRECT
 * percent-encoding under an INCORRECT (unbracketed) key. That pattern confirms hypotheses 1-3
 * (declared type never reaches the serializer / `Array.isArray` is the wrong discriminator /
 * the escape hatch inherits the gap) and refutes hypothesis 4 (encoding). If any counterexample
 * instead showed a correctly-bracketed key being rejected, hypothesis 4 would be back in play and
 * the design would need revisiting before implementing.
 *
 * OBSERVED RUN ON UNFIXED CODE (task 2): 8 failing here, and test/node_spec.js still 3 passing.
 * Every failure produced the predicted shape - correct element encoding, missing `%5B%5D` suffix.
 * The per-case counterexample strings are recorded in comments immediately above each test.
 */

var assert = require('assert');
var fc = require('fast-check');
var lib = require('../lib.js');
var fetchStub = require('./helpers/fetchStub');

var MerakiDashboardApi = lib.MerakiDashboardApi;
var buildUrlWithQuery = lib.__buildUrlWithQuery;

var DOMAIN = 'https://api.meraki.com/api/v1';
var ORG_ID = '715461';
var DEVICES_BASE = DOMAIN + '/organizations/' + ORG_ID + '/devices';

// Placeholder credential. The fetch stub means nothing leaves the process.
var FAKE_KEY = 'not-a-real-key';

/**
 * The Bug_Condition predicate, verbatim from design.md.
 *
 * @param {{name: string, value: *, declaredType: (string|undefined)}} X
 * @returns {boolean}
 */
function isBugCondition(X) {
    return X.declaredType === 'array' &&
        X.value !== null &&
        X.value !== undefined &&
        !(Array.isArray(X.value) && X.value.length === 0) &&
        X.name.slice(-2) !== '[]';
}

/**
 * Read a parameter's declared type out of endpoints.json. Derived, never hardcoded - the fix is
 * required to be type-driven (2.7), so the tests are type-driven too.
 *
 * @param {string} operationId
 * @param {string} paramName
 * @returns {string|undefined}
 */
function declaredTypeOf(operationId, paramName) {
    var endpoint = MerakiDashboardApi.getEndpoint(operationId);
    assert.ok(endpoint, 'unknown operationId in test fixture: ' + operationId);
    for (var i = 0; i < endpoint.params.length; i++) {
        if (endpoint.params[i].name === paramName && endpoint.params[i].in === 'query') {
            return endpoint.params[i].type;
        }
    }
    return undefined;
}

/**
 * Full URL of an operation with no query string, for building expectations.
 *
 * @param {string} operationId
 * @param {object} pathParams
 * @returns {string}
 */
function baseUrlOf(operationId, pathParams) {
    var endpoint = MerakiDashboardApi.getEndpoint(operationId);
    var path = endpoint.path;
    Object.keys(pathParams).forEach(function (name) {
        path = path.replace('{' + name + '}', pathParams[name]);
    });
    return DOMAIN + path;
}

/**
 * The Expected_Behavior serialization: append one pair per element under `name + '[]'`, letting
 * URLSearchParams do the encoding. Built independently of lib.js so it stays a specification of
 * the wanted output rather than a restatement of whatever lib.js currently does.
 *
 * @param {string} name
 * @param {*} value - array (each element one pair) or scalar (one pair)
 * @returns {string} query string with no leading '?'
 */
function expectedQueryString(name, value) {
    var elements = Array.isArray(value) ? value : [value];
    var searchParams = new URLSearchParams();
    elements.forEach(function (element) {
        searchParams.append(name + '[]', element);
    });
    return searchParams.toString();
}

function expectedUrl(base, name, value) {
    return base + '?' + expectedQueryString(name, value);
}

// ---------------------------------------------------------------------------
// The concrete declared-array cases. Cases 1, 2, 3 and 6 are observable at the
// buildUrlWithQuery seam; cases 4 and 5 need callEndpoint to prove the declared type is threaded
// end to end and that the escape hatch is covered.
// ---------------------------------------------------------------------------

var DIRECT_CASES = [
    {
        label: 'case 1 - multi-element array',
        requirements: '1.1 / 2.1',
        operationId: 'getOrganizationDevices',
        name: 'productTypes',
        value: ['appliance', 'switch']
    },
    {
        label: 'case 2 - single-element array',
        requirements: '1.2 / 2.2',
        operationId: 'getOrganizationDevices',
        name: 'productTypes',
        value: ['appliance']
    },
    {
        label: 'case 3 - scalar handed to a declared array (Node-RED text field)',
        requirements: '1.3 / 2.3',
        operationId: 'getOrganizationDevices',
        name: 'productTypes',
        value: 'appliance'
    },
    {
        label: 'case 6 - element needing percent-encoding',
        requirements: '2.6',
        operationId: 'getOrganizationDevices',
        name: 'productTypes',
        // space, ':', '&', '=', '/' and a non-ASCII character
        value: ['a b:c&d=e/f\u00e9']
    }
];

DIRECT_CASES.forEach(function (testCase) {
    testCase.declaredType = declaredTypeOf(testCase.operationId, testCase.name);
});

describe('Property 1: Bug Condition - declared array query parameters are bracket-suffixed', function () {

    describe('buildUrlWithQuery seam (declared type supplied directly)', function () {

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   https://api.meraki.com/api/v1/organizations/715461/devices?productTypes=appliance&productTypes=switch
        //   expected https://api.meraki.com/api/v1/organizations/715461/devices?productTypes%5B%5D=appliance&productTypes%5B%5D=switch
        // Live API: bare form returns 400 {"errors":["'productTypes' must be an array"]}; the
        // bracketed form returns 200. Encoding of the element values is already correct, so the
        // defect is the key string - hypothesis 1/2, not hypothesis 4.
        it('case 1 - multi-element array: productTypes ["appliance","switch"] emits two bracketed pairs (1.1 / 2.1)', function () {
            var entry = { name: 'productTypes', value: ['appliance', 'switch'], declaredType: declaredTypeOf('getOrganizationDevices', 'productTypes') };
            assert.strictEqual(entry.declaredType, 'array', 'endpoints.json must declare productTypes as an array');
            assert.ok(isBugCondition(entry), 'case 1 must satisfy isBugCondition');

            var actual = buildUrlWithQuery(DEVICES_BASE, { productTypes: entry.value }, { productTypes: entry.declaredType });
            assert.strictEqual(actual, expectedUrl(DEVICES_BASE, 'productTypes', entry.value));
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   ...devices?productTypes=appliance
        //   expected ...devices?productTypes%5B%5D=appliance
        // Same 400 as case 1. Confirms the single-element case is not special-cased anywhere.
        it('case 2 - single-element array: productTypes ["appliance"] emits one bracketed pair (1.2 / 2.2)', function () {
            var entry = { name: 'productTypes', value: ['appliance'], declaredType: declaredTypeOf('getOrganizationDevices', 'productTypes') };
            assert.ok(isBugCondition(entry), 'case 2 must satisfy isBugCondition');

            var actual = buildUrlWithQuery(DEVICES_BASE, { productTypes: entry.value }, { productTypes: entry.declaredType });
            assert.strictEqual(actual, expectedUrl(DEVICES_BASE, 'productTypes', entry.value));
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   ...devices?productTypes=appliance
        //   expected ...devices?productTypes%5B%5D=appliance
        // This is the Node-RED consumer path: examples.json types array query parameters as `str`
        // text fields, so the node hands buildUrlWithQuery the scalar 'appliance'. The output is
        // byte-identical to case 2's, which is exactly hypothesis 2: `Array.isArray(value)` cannot
        // distinguish a declared array supplied as a scalar from a declared scalar, so no
        // value-shape branch could ever fix this case. Only the declared type can.
        it('case 3 - scalar for a declared array: productTypes "appliance" emits one bracketed pair (1.3 / 2.3)', function () {
            var entry = { name: 'productTypes', value: 'appliance', declaredType: declaredTypeOf('getOrganizationDevices', 'productTypes') };
            assert.ok(isBugCondition(entry), 'case 3 must satisfy isBugCondition - a scalar value is still a bug input');

            var actual = buildUrlWithQuery(DEVICES_BASE, { productTypes: entry.value }, { productTypes: entry.declaredType });
            assert.strictEqual(actual, expectedUrl(DEVICES_BASE, 'productTypes', entry.value));
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   ...devices?productTypes=a+b%3Ac%26d%3De%2Ff%C3%A9
        //   expected ...devices?productTypes%5B%5D=a+b%3Ac%26d%3De%2Ff%C3%A9
        // The element encoding is character-for-character identical between actual and expected -
        // space as '+', ':' as %3A, '&' as %26, '=' as %3D, '/' as %2F, 'e-acute' as %C3%A9. Only the
        // key differs. This is the cleanest refutation of hypothesis 4: URLSearchParams is not
        // mangling anything, it is simply being handed the wrong key.
        it('case 6 - percent-encoding: element is encoded and the suffix stays %5B%5D (2.6)', function () {
            var value = ['a b:c&d=e/f\u00e9'];
            var entry = { name: 'productTypes', value: value, declaredType: declaredTypeOf('getOrganizationDevices', 'productTypes') };
            assert.ok(isBugCondition(entry), 'case 6 must satisfy isBugCondition');

            var actual = buildUrlWithQuery(DEVICES_BASE, { productTypes: value }, { productTypes: entry.declaredType });

            // Literal expectation, so this is not merely circular against expectedQueryString.
            assert.strictEqual(actual, DEVICES_BASE + '?productTypes%5B%5D=a+b%3Ac%26d%3De%2Ff%C3%A9');
            assert.strictEqual(actual, expectedUrl(DEVICES_BASE, 'productTypes', value));
        });

        // Scoped property over the four seam-observable cases. Deliberately narrow: the bug is
        // deterministic in the declared type and the value shape, so enumerating the shapes is
        // sufficient here and keeps each counterexample readable. Wide generation is task 6.
        it('scoped property: every declared-array case in the scoped domain serializes bracketed (2.1, 2.2, 2.3, 2.6)', function () {
            fc.assert(
                fc.property(fc.constantFrom.apply(null, DIRECT_CASES), function (testCase) {
                    var base = baseUrlOf(testCase.operationId, { organizationId: ORG_ID });
                    var entry = { name: testCase.name, value: testCase.value, declaredType: testCase.declaredType };

                    // Precondition: the scoped domain contains only bug inputs.
                    assert.ok(isBugCondition(entry), testCase.label + ' must satisfy isBugCondition');

                    var queryParameters = {};
                    queryParameters[testCase.name] = testCase.value;
                    var types = {};
                    types[testCase.name] = testCase.declaredType;

                    var actual = buildUrlWithQuery(base, queryParameters, types);
                    assert.strictEqual(
                        actual,
                        expectedUrl(base, testCase.name, testCase.value),
                        testCase.label + ' (' + testCase.requirements + ')'
                    );
                }),
                { numRuns: 40 }
            );
        });
    });

    describe('callEndpoint path (declared type threaded from endpoints.json)', function () {
        var capture;
        var api;

        beforeEach(function () {
            capture = fetchStub.install();
            api = new MerakiDashboardApi(DOMAIN);
            api.setApiKey(FAKE_KEY, 'X-Cisco-Meraki-API-Key', false);
        });

        afterEach(function () {
            fetchStub.restore();
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   https://api.meraki.com/api/v1/organizations/715461/devices/cellular/data/usage/history/byDevice/byInterval?serials=Q2XX-XXXX-XXXX
        //   expected ...byInterval?serials%5B%5D=Q2XX-XXXX-XXXX
        // `serials` is required:true here, so there is no call that omits it: the operation is
        // entirely unreachable, which is requirement 1.4's class. This case also localises the
        // defect - callEndpoint has paramDef.type in hand and drops it at
        // `queryParameters[paramName] = paramValue`, which is hypothesis 1 stated exactly.
        it('case 4 - required array parameter: serials on getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval is bracketed (1.4 / 2.4)', function () {
            var operationId = 'getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval';
            var value = ['Q2XX-XXXX-XXXX'];
            var entry = { name: 'serials', value: value, declaredType: declaredTypeOf(operationId, 'serials') };
            assert.strictEqual(entry.declaredType, 'array', 'endpoints.json must declare serials as an array');
            assert.ok(isBugCondition(entry), 'case 4 must satisfy isBugCondition');

            var base = baseUrlOf(operationId, { organizationId: ORG_ID });

            return api.callEndpoint(operationId, { organizationId: ORG_ID, serials: value })
                .then(function () {
                    assert.strictEqual(capture.count, 1, 'exactly one request should have been issued');
                    assert.strictEqual(capture.url, expectedUrl(base, 'serials', value));
                });
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   ...devices?networkIds=N_1&networkIds=N_2
        //   expected ...devices?networkIds%5B%5D=N_1&networkIds%5B%5D=N_2
        // $queryParameters is merged into the same flat queryParameters object with no type
        // annotation, so the escape hatch inherits the identical bare form - hypothesis 3. A caller
        // cannot reach a working request through it without pre-bracketing the key themselves.
        it('case 5 - escape hatch through callEndpoint: $queryParameters networkIds array is bracketed (1.5 / 2.5)', function () {
            var value = ['N_1', 'N_2'];
            var base = baseUrlOf('getOrganizationDevices', { organizationId: ORG_ID });

            return api.callEndpoint('getOrganizationDevices', {
                organizationId: ORG_ID,
                $queryParameters: { networkIds: value }
            }).then(function () {
                assert.strictEqual(capture.count, 1, 'exactly one request should have been issued');
                assert.strictEqual(capture.url, expectedUrl(base, 'networkIds', value));
            });
        });

        // COUNTEREXAMPLE (unfixed code, observed):
        //   actual   ...devices?networkIds=N_1&networkIds=N_2
        //   expected ...devices?networkIds%5B%5D=N_1&networkIds%5B%5D=N_2
        // Same string as the case above, reached with NO type map at all. isBugCondition is false
        // for this entry (there is no declaredType), so it is not a Property 1 input - it is
        // requirement 2.5 resting on the design's rule 6, "no declared type + array value =>
        // bracket". Asserted here so the escape hatch is pinned at the serializer seam too, where
        // the absent-type decision actually lives.
        it('case 5 - escape hatch at the seam: an untyped array value is bracketed (1.5 / 2.5, design rule 6)', function () {
            var value = ['N_1', 'N_2'];
            var entry = { name: 'networkIds', value: value, declaredType: undefined };
            assert.ok(!isBugCondition(entry), 'an untyped escape-hatch key is outside isBugCondition by construction');

            var actual = buildUrlWithQuery(DEVICES_BASE, { networkIds: value }, {});
            assert.strictEqual(actual, expectedUrl(DEVICES_BASE, 'networkIds', value));
        });
    });
});
