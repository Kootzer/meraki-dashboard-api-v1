'use strict';

/**
 * Unit coverage for the ordered decision procedure inside buildUrlWithQuery.
 *
 * design.md's Fix Implementation section specifies serialization as a 7-row table evaluated in a
 * FIXED order, and states plainly that "the order is the specification, not an implementation
 * detail". This file therefore does two distinct things:
 *
 *   1. One test per row, naming the row it covers, so each rule is pinned independently.
 *   2. Tests that pin the ORDER, i.e. inputs that satisfy more than one row's condition and must
 *      be resolved by the earlier row. Row-by-row tests alone cannot catch a mis-ordered table.
 *
 * The table, verbatim from design.md:
 *
 *   | # | Condition                              | Action                                        | Req         |
 *   | 1 | value is null or undefined             | skip the key                                  | 3.3         |
 *   | 2 | value is an array of length 0          | skip the key                                  | 3.4         |
 *   | 3 | key ends with '[]'                     | append under the key unchanged                | 3.6         |
 *   | 4 | declared type is 'array'               | one pair per element under key + '[]'         | 2.1,2.2,2.3 |
 *   | 5 | declared type present and not 'array'  | bare key (arrays as repeated bare pairs)      | 3.1,3.2,3.7 |
 *   | 6 | no declared type, value is an array    | one pair per element under key + '[]'         | 2.5         |
 *   | 7 | no declared type, scalar value         | bare key                                      | 3.1,3.2,3.7 |
 *
 * Declared types are read out of endpoints.json at test time rather than hardcoded, and the one
 * "undeclared" key used below is asserted to be genuinely undeclared for its operation rather than
 * assumed to be. The fix is required to be type-driven (2.7), so the tests are too.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7
 */

var assert = require('assert');
var lib = require('../lib.js');
var fetchStub = require('./helpers/fetchStub');

var MerakiDashboardApi = lib.MerakiDashboardApi;
var buildUrlWithQuery = lib.__buildUrlWithQuery;

var DOMAIN = 'https://api.meraki.com/api/v1';
var ORG_ID = '715461';
var BASE = DOMAIN + '/organizations/' + ORG_ID + '/devices';

// Placeholder credential. fetch is stubbed, so nothing leaves the process.
var FAKE_KEY = 'not-a-real-key';

/**
 * Read a query parameter's declared type out of endpoints.json.
 *
 * @param {string} operationId
 * @param {string} paramName
 * @returns {string|undefined} the declared type, or undefined if the operation does not declare
 *     paramName as a query parameter at all
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

describe('buildUrlWithQuery decision table', function () {

    // -----------------------------------------------------------------------
    // One test per row.
    // -----------------------------------------------------------------------
    describe('row by row', function () {

        it('rule 1 - value is null or undefined: the key is skipped (3.3)', function () {
            // Both absent forms, and at a declared type that would otherwise bracket (rule 4) as
            // well as one that would otherwise go bare (rule 5), so rule 1 is shown to win in both
            // directions rather than only where the fallthrough happens to agree.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: null, perPage: 100 }, { productTypes: 'array', perPage: 'integer' }),
                BASE + '?perPage=100'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: undefined, perPage: 100 }, { productTypes: 'array', perPage: 'integer' }),
                BASE + '?perPage=100'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { startingAfter: null }, { startingAfter: 'string' }),
                BASE
            );
        });

        it('rule 2 - value is an array of length 0: the key is skipped, neither macs= nor macs%5B%5D= (3.4)', function () {
            var actual = buildUrlWithQuery(BASE, { macs: [], perPage: 100 }, { macs: 'array', perPage: 'integer' });

            assert.strictEqual(actual, BASE + '?perPage=100');
            assert.strictEqual(actual.indexOf('macs'), -1, 'an empty array must not appear in any form');
        });

        it('rule 3 - key ends with []: appended under the key unchanged (3.6)', function () {
            // No declared type in play here, so only rule 3 can be responsible. The scalar case and
            // the array case are both covered; URLSearchParams emits the suffix as %5B%5D.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { 'productTypes[]': 'appliance' }, {}),
                BASE + '?productTypes%5B%5D=appliance'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { 'productTypes[]': ['appliance', 'switch'] }, {}),
                BASE + '?productTypes%5B%5D=appliance&productTypes%5B%5D=switch'
            );
        });

        it('rule 4 - declared type is array: one bracketed pair per element, scalar counting as one (2.1, 2.2, 2.3)', function () {
            var declaredType = declaredTypeOf('getOrganizationDevices', 'productTypes');
            assert.strictEqual(declaredType, 'array', 'endpoints.json must declare productTypes as an array');

            // Multi-element (2.1)
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: ['appliance', 'switch'] }, { productTypes: declaredType }),
                BASE + '?productTypes%5B%5D=appliance&productTypes%5B%5D=switch'
            );
            // Single-element (2.2)
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: ['appliance'] }, { productTypes: declaredType }),
                BASE + '?productTypes%5B%5D=appliance'
            );
            // Scalar treated as a one-element array - the Node-RED text-field case (2.3)
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: 'appliance' }, { productTypes: declaredType }),
                BASE + '?productTypes%5B%5D=appliance'
            );
        });

        it('rule 5 - declared type present and not array: bare key, arrays as repeated bare pairs (3.1, 3.2, 3.7)', function () {
            assert.strictEqual(declaredTypeOf('getOrganizationDevices', 'startingAfter'), 'string');
            assert.strictEqual(declaredTypeOf('getOrganizationDevices', 'perPage'), 'integer');

            // Declared scalars stay bare, and keep space-as-'+' encoding (3.1, 3.2).
            assert.strictEqual(
                buildUrlWithQuery(BASE, { perPage: 100, startingAfter: 'a b' }, { perPage: 'integer', startingAfter: 'string' }),
                BASE + '?perPage=100&startingAfter=a+b'
            );
            // Falsy-but-valid values survive rather than being dropped (3.7).
            assert.strictEqual(
                buildUrlWithQuery(BASE, { includeAll: false, offset: 0, note: '' }, { includeAll: 'boolean', offset: 'integer', note: 'string' }),
                BASE + '?includeAll=false&offset=0&note='
            );
            // A declared scalar handed a JavaScript array: repeated BARE pairs, never bracketed.
            // This is the case that discriminates the chosen design from rejected alternative A.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { startingAfter: ['a', 'b'] }, { startingAfter: 'string' }),
                BASE + '?startingAfter=a&startingAfter=b'
            );
        });

        it('rule 6 - no declared type, array value: one bracketed pair per element (2.5)', function () {
            // Empty type map, so there is no declared type for the key to find. This is the
            // $queryParameters escape hatch for a key no operation declares.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { networkIds: ['N_1', 'N_2'] }, {}),
                BASE + '?networkIds%5B%5D=N_1&networkIds%5B%5D=N_2'
            );
            // Also with a non-empty map that simply does not contain the key, so the distinction
            // being tested is genuinely "absent from the map" and not "map is empty".
            assert.strictEqual(
                buildUrlWithQuery(BASE, { networkIds: ['N_1'] }, { perPage: 'integer' }),
                BASE + '?networkIds%5B%5D=N_1'
            );
        });

        it('rule 7 - no declared type, scalar value: bare key (3.1, 3.2, 3.7)', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { someKey: 'a b' }, {}),
                BASE + '?someKey=a+b'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { flag: false, zero: 0, blank: '' }, {}),
                BASE + '?flag=false&zero=0&blank='
            );
        });
    });

    // -----------------------------------------------------------------------
    // Ordering. Each input below satisfies more than one row's condition; the
    // assertion is that the EARLIER row resolves it.
    // -----------------------------------------------------------------------
    describe('rule ordering', function () {

        // Rule 3 must precede rule 4. A caller who worked around the bare-form bug by passing
        // 'productTypes[]' through $queryParameters, on an operation that also declares
        // productTypes as an array, satisfies both rows. If rule 4 won, the key would become
        // 'productTypes[][]', which the live API rejects with
        // 400 {"errors":["Each element in 'productTypes' must be a string"]} - so mis-ordering
        // would break exactly the callers who had already worked around the bug.
        it('rule 3 beats rule 4 - a []-suffixed key with declared type array emits a single %5B%5D, array value (3.6)', function () {
            var actual = buildUrlWithQuery(
                BASE,
                { 'productTypes[]': ['appliance', 'switch'] },
                { 'productTypes[]': 'array' }
            );

            assert.strictEqual(actual, BASE + '?productTypes%5B%5D=appliance&productTypes%5B%5D=switch');
            assert.strictEqual(actual.indexOf('%5B%5D%5B%5D'), -1, 'must not double-bracket into productTypes[][]');
            assert.strictEqual(actual.indexOf('productTypes[]'), -1, 'the suffix is percent-encoded, never literal');
        });

        it('rule 3 beats rule 4 - a []-suffixed key with declared type array emits a single %5B%5D, scalar value (3.6)', function () {
            var actual = buildUrlWithQuery(
                BASE,
                { 'productTypes[]': 'appliance' },
                { 'productTypes[]': 'array' }
            );

            assert.strictEqual(actual, BASE + '?productTypes%5B%5D=appliance');
            assert.strictEqual(actual.indexOf('%5B%5D%5B%5D'), -1, 'must not double-bracket into productTypes[][]');
        });

        it('rules 1 and 2 beat rule 4 - an absent or empty value at declared type array is still skipped (3.3, 3.4)', function () {
            // Rule 4 would otherwise fire on all three of these, and would turn the empty array
            // into nothing (harmless) but null/undefined into 'productTypes%5B%5D=' (not harmless).
            assert.strictEqual(buildUrlWithQuery(BASE, { productTypes: null }, { productTypes: 'array' }), BASE);
            assert.strictEqual(buildUrlWithQuery(BASE, { productTypes: undefined }, { productTypes: 'array' }), BASE);
            assert.strictEqual(buildUrlWithQuery(BASE, { productTypes: [] }, { productTypes: 'array' }), BASE);
        });

        it('rule 5 beats rule 6 - a declared-string parameter handed an array stays bare, while an undeclared key brackets (3.1 vs 2.5)', function () {
            // Same value shape, same call, two keys. The ONLY difference is whether the key is
            // present in the type map, which is exactly the distinction rules 5 and 6 turn on -
            // and the reason lib.js uses hasOwnProperty rather than truthiness.
            var value = ['a', 'b'];
            var actual = buildUrlWithQuery(
                BASE,
                { startingAfter: value, undeclaredKey: value },
                { startingAfter: 'string' }
            );

            assert.strictEqual(
                actual,
                BASE + '?startingAfter=a&startingAfter=b&undeclaredKey%5B%5D=a&undeclaredKey%5B%5D=b'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Encoding. Pins design Decision 3: URLSearchParams is retained, so the
    // suffix is emitted as %5B%5D and element values keep their existing
    // encoding (space as '+', not %20).
    // -----------------------------------------------------------------------
    describe('encoding (design Decision 3)', function () {

        it('rule 4 output uses the %5B%5D suffix and URLSearchParams element encoding (2.1, 3.2)', function () {
            var actual = buildUrlWithQuery(
                BASE,
                { productTypes: ['a b', 'c:d&e=f/g\u00e9'] },
                { productTypes: 'array' }
            );

            assert.strictEqual(
                actual,
                BASE + '?productTypes%5B%5D=a+b&productTypes%5B%5D=c%3Ad%26e%3Df%2Fg%C3%A9'
            );
            // Space as '+' is the preserved behavior, not %20 (3.2).
            assert.ok(actual.indexOf('a+b') !== -1, 'space must still encode as +');
            assert.strictEqual(actual.indexOf('%20'), -1, 'space must not shift to %20');
            // The suffix is the percent-encoded form the live-API evidence table confirms.
            assert.strictEqual(actual.indexOf('productTypes[]'), -1, 'no literal [] in the output');
        });
    });

    // -----------------------------------------------------------------------
    // Omission, stated against the rule numbers, plus the nothing-survives case.
    // -----------------------------------------------------------------------
    describe('omission', function () {

        it('rule 1 - null and undefined are omitted entirely (3.3)', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { a: null, b: undefined, c: 'kept' }, {}),
                BASE + '?c=kept'
            );
        });

        it('rule 2 - an empty array is omitted entirely (3.4)', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { a: [], c: 'kept' }, { a: 'array' }),
                BASE + '?c=kept'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { a: [], c: 'kept' }, {}),
                BASE + '?c=kept'
            );
        });

        it('rules 1 and 2 - when nothing survives filtering the bare base URL is returned, with no trailing ? (3.5)', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { a: null, b: undefined, c: [], 'd[]': [] }, { a: 'array', b: 'string', c: 'array' }),
                BASE
            );
            // The degenerate case too: no query parameters at all.
            assert.strictEqual(buildUrlWithQuery(BASE, {}, {}), BASE);
            assert.strictEqual(buildUrlWithQuery(BASE, {}), BASE);
        });
    });

    // -----------------------------------------------------------------------
    // The same decisions reached through callEndpoint, which is where the type
    // map is actually built. This is the part that proves WHICH rule fires for
    // a $queryParameters key, rather than only that the output is bracketed.
    // -----------------------------------------------------------------------
    describe('through callEndpoint', function () {
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

        // $queryParameters shadowing a DECLARED array parameter. design.md Decision 2 says this
        // "does find a type in the map, and is bracketed on that basis. That is intended - the
        // shadowing value is still bound for the same API parameter."
        //
        // Note that callEndpoint records declared query types UNCONDITIONALLY, including when the
        // caller passed no value for them, so the type map contains networkIds even though the
        // value arrived via $queryParameters. The bracketing therefore comes from rule 4, not
        // rule 6. A SCALAR value proves which rule fired: rule 6 requires an array value and so
        // cannot possibly be responsible here.
        it('$queryParameters shadowing a declared array is bracketed via rule 4, proven with a scalar value (2.3, 2.5)', function () {
            var operationId = 'getOrganizationDevices';
            assert.strictEqual(
                declaredTypeOf(operationId, 'networkIds'),
                'array',
                'this test needs networkIds to BE declared on ' + operationId + ' - that is the point of it'
            );

            return api.callEndpoint(operationId, {
                organizationId: ORG_ID,
                $queryParameters: { networkIds: 'N_1' }
            }).then(function () {
                assert.strictEqual(capture.count, 1);
                assert.strictEqual(capture.url, BASE + '?networkIds%5B%5D=N_1');
            });
        });

        it('$queryParameters shadowing a declared array is bracketed for an array value too (2.5)', function () {
            return api.callEndpoint('getOrganizationDevices', {
                organizationId: ORG_ID,
                $queryParameters: { networkIds: ['N_1', 'N_2'] }
            }).then(function () {
                assert.strictEqual(capture.url, BASE + '?networkIds%5B%5D=N_1&networkIds%5B%5D=N_2');
            });
        });

        // Genuine rule 6 coverage. Because declared types are recorded unconditionally, rule 6 is
        // only reachable through callEndpoint via a key the operation does NOT declare at all.
        it('rule 6 through callEndpoint - a key the operation does not declare, with an array value, is bracketed (2.5)', function () {
            var operationId = 'getOrganizationDevices';
            var undeclared = 'notADeclaredParam';
            assert.strictEqual(
                declaredTypeOf(operationId, undeclared),
                undefined,
                undeclared + ' must be genuinely undeclared on ' + operationId + ' for rule 6 to be reachable'
            );

            var params = { organizationId: ORG_ID, $queryParameters: {} };
            params.$queryParameters[undeclared] = ['x', 'y'];

            return api.callEndpoint(operationId, params).then(function () {
                assert.strictEqual(capture.url, BASE + '?' + undeclared + '%5B%5D=x&' + undeclared + '%5B%5D=y');
            });
        });

        it('rule 7 through callEndpoint - the same undeclared key with a scalar value stays bare (3.1)', function () {
            var operationId = 'getOrganizationDevices';
            var undeclared = 'notADeclaredParam';
            assert.strictEqual(declaredTypeOf(operationId, undeclared), undefined);

            var params = { organizationId: ORG_ID, $queryParameters: {} };
            params.$queryParameters[undeclared] = 'x';

            return api.callEndpoint(operationId, params).then(function () {
                assert.strictEqual(capture.url, BASE + '?' + undeclared + '=x');
            });
        });

        it('rule 3 through callEndpoint - a pre-bracketed $queryParameters key stays single-bracketed (3.6)', function () {
            return api.callEndpoint('getOrganizationDevices', {
                organizationId: ORG_ID,
                $queryParameters: { 'productTypes[]': 'appliance' }
            }).then(function () {
                assert.strictEqual(capture.url, BASE + '?productTypes%5B%5D=appliance');
                assert.strictEqual(capture.url.indexOf('%5B%5D%5B%5D'), -1);
            });
        });

        it('rules 4 and 5 side by side through callEndpoint - declared array brackets, declared scalar stays bare (2.1, 3.1)', function () {
            return api.callEndpoint('getOrganizationDevices', {
                organizationId: ORG_ID,
                perPage: 100,
                productTypes: ['appliance', 'switch']
            }).then(function () {
                // Key order follows endpoint.params order in endpoints.json: perPage precedes
                // productTypes there.
                assert.strictEqual(
                    capture.url,
                    BASE + '?perPage=100&productTypes%5B%5D=appliance&productTypes%5B%5D=switch'
                );
            });
        });

        it('rules 1 and 2 through callEndpoint - omitted and empty-array parameters leave the URL bare (3.3, 3.4, 3.5)', function () {
            return api.callEndpoint('getOrganizationDevices', {
                organizationId: ORG_ID,
                productTypes: null,
                macs: []
            }).then(function () {
                assert.strictEqual(capture.url, BASE, 'no query string at all, not even a trailing ?');
            });
        });
    });
});

/**
 * Rule 4 and non-scalar elements: fail loudly rather than emit `[object Object]`.
 *
 * Before this change, a declared-array parameter handed object elements went through rule 4 like
 * any other array: URLSearchParams stringified each element via String(), so `ranges` on
 * getOrganizationCameraDetectionsHistoryByBoundaryByInterval reached the wire as
 * `ranges%5B%5D=%5Bobject+Object%5D` and the API answered with a confusing 400.
 *
 * The correct query-string wire format for object elements is NOT specified by the OpenAPI spec
 * (which declares only the element shape) and has never been verified against the live API, so no
 * encoding is implemented here. Rule 4 throws instead, with a message naming the parameter.
 *
 * SCOPE - this applies to rule 4 ONLY, and the preservation tests below are as load-bearing as the
 * rejection tests:
 *
 *   - rule 3 (key already ends in '[]') keeps its pre-existing behavior, per preservation clause
 *     3.6, including for object elements
 *   - rule 5 (declared type present and not 'array') keeps its pre-existing behavior, per
 *     preservation clauses 3.1/3.2/3.7, including a declared-`string` parameter handed an object
 *   - rule 6 (the no-declared-type $queryParameters escape hatch) stays permissive on purpose:
 *     that path is for callers who know what they are doing
 *
 * WHY THIS DOES NOT VIOLATE PROPERTY 2 (preservation). An object-element value under a declared
 * array satisfies isBugCondition - declared type is 'array', the value is present, it is not an
 * empty array, and the name does not end in '[]' - so it sits in the FIX domain, not the
 * preservation domain. Property 2 quantifies only over inputs where isBugCondition is false, so
 * changing this input's behavior is outside its scope. The three preservation cases below are the
 * inputs that genuinely are in Property 2's domain, and they are asserted byte-for-byte.
 *
 * WHY THE FAILURE SHAPE MATTERS AS MUCH AS THE FAILURE. buildUrlWithQuery is synchronous and is
 * called from MerakiDashboardApi.prototype.request. A synchronous throw would escape the promise
 * chain, so callEndpoint(...).catch(...) would never see it and node.js's .catch() handler would be
 * bypassed entirely - the error would come out of the Node-RED input handler instead of the debug
 * pane. request() converts it to a rejection for that reason, and the tests below pin that.
 *
 * Validates: Requirements 2.7, 3.1, 3.2, 3.6, 3.7
 * Non-Goal: arrays whose elements are not scalars - no encoding is guessed
 */
describe('buildUrlWithQuery rule 4: non-scalar array elements fail loudly (2.7, Non-Goal)', function () {

    var RANGE = { startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z', interval: 3600 };

    describe('rejection at the serializer', function () {

        it('throws for an object element under a declared array, naming the parameter', function () {
            assert.throws(function () {
                buildUrlWithQuery(BASE, { ranges: [RANGE] }, { ranges: 'array' });
            }, function (err) {
                assert.ok(err instanceof Error, 'should be an Error');
                assert.ok(err.message.indexOf('ranges') !== -1, 'must name the parameter: ' + err.message);
                assert.ok(/scalar/.test(err.message), 'should say scalars are required: ' + err.message);
                return true;
            });
        });

        it('throws for a bare object supplied to a declared array (the scalar-counts-as-one path)', function () {
            // Rule 4 wraps a non-array value into a one-element array, so the check has to cover
            // that shape too rather than only genuine arrays.
            assert.throws(function () {
                buildUrlWithQuery(BASE, { ranges: RANGE }, { ranges: 'array' });
            }, /ranges/);
        });

        it('throws for a nested array element under a declared array', function () {
            // `typeof [] === 'object'`, so nested arrays are caught by the same check. There is no
            // more of a specified encoding for them than for objects.
            assert.throws(function () {
                buildUrlWithQuery(BASE, { serials: [[1, 2]] }, { serials: 'array' });
            }, /serials/);
        });

        it('names the offending element index, so a mixed array is actionable', function () {
            assert.throws(function () {
                buildUrlWithQuery(BASE, { serials: ['Q2XX-XXXX-XXXX', RANGE] }, { serials: 'array' });
            }, function (err) {
                assert.ok(/element 1/.test(err.message), 'should point at element 1: ' + err.message);
                return true;
            });
        });

        it('emits no partial query string - the throw happens before anything is appended', function () {
            // Validating up front rather than mid-append means there is no half-built URL to leak,
            // and no chance of a caller catching the error and using a truncated result.
            assert.throws(function () {
                buildUrlWithQuery(BASE, { perPage: 100, ranges: [RANGE] }, { perPage: 'integer', ranges: 'array' });
            }, /ranges/);
        });

        it('still accepts scalar elements of every kind, so the check is not over-broad', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { serials: ['a', 1, false] }, { serials: 'array' }),
                BASE + '?serials%5B%5D=a&serials%5B%5D=1&serials%5B%5D=false'
            );
        });

        it('leaves null and undefined ELEMENTS behaving exactly as before - no new handling added', function () {
            // `typeof null === 'object'` but the check excludes it explicitly. These elements have
            // always stringified to 'null' / 'undefined' and that is deliberately untouched: this
            // change is about object elements only.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { serials: [null, undefined] }, { serials: 'array' }),
                BASE + '?serials%5B%5D=null&serials%5B%5D=undefined'
            );
        });
    });

    describe('the failure reaches callers as a REJECTED PROMISE, not a synchronous throw', function () {
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

        // This is the regression guard for the try/catch in request(). Without it, the throw from
        // buildUrlWithQuery escapes synchronously and every `.catch()` downstream is bypassed.
        it('callEndpoint does not throw synchronously and returns a promise that rejects', function () {
            var returned;

            assert.doesNotThrow(function () {
                returned = api.callEndpoint('getOrganizationCameraDetectionsHistoryByBoundaryByInterval', {
                    organizationId: ORG_ID,
                    boundaryIds: ['boundary-1'],
                    ranges: [RANGE]
                });
            }, 'the error must not escape callEndpoint synchronously');

            assert.ok(returned, 'callEndpoint should have returned a value');
            assert.strictEqual(typeof returned.then, 'function', 'the returned value should be a promise');

            return returned.then(function () {
                assert.fail('expected the promise to reject');
            }, function (err) {
                assert.ok(err instanceof Error);
                assert.ok(err.message.indexOf('ranges') !== -1, 'the rejection should name ranges: ' + err.message);
                assert.strictEqual(capture.count, 0, 'no HTTP request may be made');
            });
        });

        it('request() itself rejects rather than throwing, for direct callers of the prototype method', function () {
            var returned;

            assert.doesNotThrow(function () {
                returned = api.request('GET', BASE, {}, {}, { serials: [{ a: 1 }] }, { serials: 'array' });
            }, 'request() must convert the throw into a rejection');

            return returned.then(function () {
                assert.fail('expected the promise to reject');
            }, function (err) {
                assert.ok(err.message.indexOf('serials') !== -1, 'the rejection should name serials: ' + err.message);
                assert.strictEqual(capture.count, 0, 'no HTTP request may be made');
            });
        });
    });

    describe('PRESERVATION - the other rules are untouched, objects included', function () {

        it('rule 5: a declared-string parameter handed an object is UNCHANGED (3.1, 3.2, 3.7)', function () {
            // Preservation clauses 3.1/3.2/3.7 require declared non-array parameters to be
            // byte-identical. `name` on getOrganizationDevices is declared "type": "string", and
            // handing it an object has always produced this. It still does - no rejection.
            assert.strictEqual(
                declaredTypeOf('getOrganizationDevices', 'name'),
                'string',
                'this test needs name to be declared a string'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { name: { a: 1 } }, { name: 'string' }),
                BASE + '?name=%5Bobject+Object%5D'
            );
        });

        it('rule 5: a declared-string parameter handed an ARRAY of objects is UNCHANGED (3.1)', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { name: [{ a: 1 }, { b: 2 }] }, { name: 'string' }),
                BASE + '?name=%5Bobject+Object%5D&name=%5Bobject+Object%5D'
            );
        });

        it('rule 3: an already-bracketed key with object elements is UNCHANGED (3.6)', function () {
            // Preservation clause 3.6 covers keys that already end in '[]', so rule 3 must stay
            // byte-identical. Rule 3 is evaluated BEFORE rule 4, which is what keeps this out of
            // the new check's reach.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { 'ranges[]': [RANGE] }, {}),
                BASE + '?ranges%5B%5D=%5Bobject+Object%5D'
            );
        });

        it('rule 3 wins even when the bracketed key is ALSO declared an array (3.6, ordering)', function () {
            // The ordering test from the decision table, re-run with object elements: rule 3 has to
            // win, so this must not reject and must not be double-bracketed.
            var url = buildUrlWithQuery(BASE, { 'ranges[]': [RANGE] }, { 'ranges[]': 'array' });
            assert.strictEqual(url, BASE + '?ranges%5B%5D=%5Bobject+Object%5D');
            assert.strictEqual(url.indexOf('%5B%5D%5B%5D'), -1);
        });

        it('rule 6: a $queryParameters key with no declared type and object elements is UNCHANGED', function () {
            // The escape hatch stays permissive by design - it is for callers who know what they
            // are doing, and narrowing it is explicitly out of scope for this change.
            assert.strictEqual(
                buildUrlWithQuery(BASE, { whateverIds: [RANGE] }, {}),
                BASE + '?whateverIds%5B%5D=%5Bobject+Object%5D'
            );
        });

        it('rule 6 through callEndpoint: an undeclared $queryParameters key with object elements does not reject', function () {
            var capture = fetchStub.install();
            var api = new MerakiDashboardApi(DOMAIN);
            api.setApiKey(FAKE_KEY, 'X-Cisco-Meraki-API-Key', false);

            var operationId = 'getOrganizationDevices';
            var undeclared = 'notADeclaredParam';
            assert.strictEqual(
                declaredTypeOf(operationId, undeclared),
                undefined,
                undeclared + ' must be genuinely undeclared for rule 6 to be reachable'
            );

            var params = { organizationId: ORG_ID, $queryParameters: {} };
            params.$queryParameters[undeclared] = [RANGE];

            return api.callEndpoint(operationId, params).then(function () {
                assert.strictEqual(capture.count, 1, 'the escape hatch must still make the request');
                assert.strictEqual(capture.url, BASE + '?' + undeclared + '%5B%5D=%5Bobject+Object%5D');
                fetchStub.restore();
            }, function (err) {
                fetchStub.restore();
                throw err;
            });
        });

        it('rule 7: no declared type and a bare object value is UNCHANGED', function () {
            assert.strictEqual(
                buildUrlWithQuery(BASE, { whatever: { a: 1 } }, {}),
                BASE + '?whatever=%5Bobject+Object%5D'
            );
        });
    });
});
