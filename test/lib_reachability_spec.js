'use strict';

/**
 * Required-array operations: which ones the fix actually makes reachable, and the one it does not.
 *
 * Eight operations in endpoints.json declare at least one query parameter that is BOTH
 * `"type": "array"` and `"required": true`. Before the fix every possible call to them carried a
 * malformed parameter, so all eight were unreachable: there was no argument a caller could pass
 * that produced a request the API would accept.
 *
 * The fix makes SEVEN of the eight reachable. It does not make eight reachable, and this file is
 * deliberately explicit about that:
 *
 *   - Requirement 2.4 says all 8 unreachable operations become reachable. That is an
 *     OVERSTATEMENT. The real outcome is 7 of 8. design.md's Non-Goals section states it directly:
 *     "requirement 2.4 overstates the outcome: 7 of the 8 unreachable operations become
 *     reachable."
 *   - The exception is getOrganizationCameraDetectionsHistoryByBoundaryByInterval. It has TWO
 *     required array parameters, `boundaryIds` and `ranges`. `boundaryIds` takes scalar elements
 *     and is fixed. `ranges` takes OBJECT elements, and the query-string wire format for object
 *     elements is not specified by the OpenAPI spec and has never been verified against the live
 *     API, so this client does not implement it. It used to be bracketed and stringified to
 *     `ranges[]=[object Object]`, producing a confusing 400; it now fails with an explicit error
 *     naming the parameter. Because `ranges` is required alongside `boundaryIds`, fixing
 *     `boundaryIds` is necessary but NOT SUFFICIENT, and the operation stays unreachable. Correct
 *     encoding for arrays of objects remains out of scope per Non-Goals.
 *
 * The last tests below record that limitation as a known-unfixed observation: the operation is
 * still unreachable, it just now says so clearly instead of emitting a malformed URL. That is NOT
 * a passing fix for `ranges` and must not be read or cited as one.
 *
 * WHAT "ACCEPTED-SHAPE" MEANS HERE
 *
 * design.md's live-API evidence table (Design Decision 3, read-only GETs against org 715461)
 * establishes that Meraki accepts and genuinely honours the percent-encoded suffix form
 * `name%5B%5D=value`, and rejects both the bare form (`400 'productTypes' must be an array`) and
 * the double-bracketed form (`400 Each element in 'productTypes' must be a string`). So
 * "accepted-shape" is asserted as: one `name[]=element` pair per element in caller order, zero
 * bare `name=` pairs, the literal `%5B%5D` suffix present in the raw URL, and no `%5B%5D%5B%5D`
 * anywhere. No live calls are made from this file - fetch is stubbed throughout.
 *
 * WHY THE OPERATION LIST IS VERIFIED AGAINST endpoints.json RATHER THAN TRUSTED
 *
 * The seven operation names and their required array parameters are written out below as an
 * expected table, but every one is checked against endpoints.json via `getEndpoint` before it is
 * used, and the required-array set is additionally DERIVED from endpoints.json and asserted to
 * equal that table exactly. A regenerated endpoints.json (update_from_openapi.js) that adds,
 * removes or retypes a required array parameter therefore surfaces as a failing test with a
 * readable diff, instead of silently drifting away from what this file claims.
 *
 * Validates: Requirements 2.4 (PARTIAL - 7 of 8 operations, see above), 2.7
 * Non-Goal: arrays whose elements are not scalars
 */

var assert = require('assert');
var lib = require('../lib.js');
var fetchStub = require('./helpers/fetchStub');

var MerakiDashboardApi = lib.MerakiDashboardApi;

var DOMAIN = 'https://api.meraki.com/api/v1';
var ORG_ID = '715461';

// Placeholder credential. fetch is stubbed, so nothing leaves the process and no key is needed.
var FAKE_KEY = 'not-a-real-key';

/**
 * The seven operations the fix makes reachable, with the required array parameter that used to
 * make them unreachable. Each entry also carries the non-array path/query values needed to get
 * callEndpoint past its required-parameter checks.
 *
 * Verified against endpoints.json below, not trusted.
 */
var NEWLY_REACHABLE = [
    {
        operationId: 'getAdministeredLicensingSubscriptionSubscriptions',
        requiredArray: 'organizationIds',
        otherParameters: {},
        elements: ['715461', '123456']
    },
    {
        operationId: 'getAdministeredLicensingSubscriptionSubscriptionsComplianceStatuses',
        requiredArray: 'organizationIds',
        otherParameters: {},
        elements: ['715461', '123456']
    },
    {
        operationId: 'getOrganizationCampusGatewayClustersTunnelable',
        requiredArray: 'fromNetworkIds',
        otherParameters: { organizationId: ORG_ID },
        elements: ['N_1', 'N_2']
    },
    {
        operationId: 'getOrganizationCellularGatewayEsimsServiceProvidersAccountsCommunicationPlans',
        requiredArray: 'accountIds',
        otherParameters: { organizationId: ORG_ID },
        elements: ['acct-1', 'acct-2']
    },
    {
        operationId: 'getOrganizationCellularGatewayEsimsServiceProvidersAccountsRatePlans',
        requiredArray: 'accountIds',
        otherParameters: { organizationId: ORG_ID },
        elements: ['acct-1', 'acct-2']
    },
    {
        operationId: 'getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval',
        requiredArray: 'serials',
        otherParameters: { organizationId: ORG_ID },
        elements: ['Q2XX-XXXX-XXXX', 'Q2YY-YYYY-YYYY']
    },
    {
        operationId: 'getOrganizationPoliciesAssignmentsByClient',
        requiredArray: 'networkIds',
        otherParameters: { organizationId: ORG_ID },
        elements: ['N_1', 'N_2']
    }
];

/**
 * The eighth operation. Listed separately, and NOT in NEWLY_REACHABLE, because it is not fixed.
 */
var STAYS_UNREACHABLE = {
    operationId: 'getOrganizationCameraDetectionsHistoryByBoundaryByInterval',
    // Both are required arrays. boundaryIds is fixed; ranges is not.
    fixedRequiredArray: 'boundaryIds',
    unfixedRequiredArray: 'ranges',
    otherParameters: { organizationId: ORG_ID }
};

/**
 * Parse a built URL's query string into an exact key -> values map.
 *
 * URLSearchParams percent-decodes keys on parse, so a `%5B%5D` suffix comes back as a literal
 * `[]`. Exact-key lookup via getAll() is what makes "bracketed" and "bare" unambiguously
 * distinguishable; substring matching on the raw URL cannot do that, because one parameter name
 * can be a suffix of another (`ids` inside `networkIds`) and `%5B%5D` contains no literal `[]`.
 *
 * @param {string} url
 * @returns {URLSearchParams}
 */
function queryOf(url) {
    return new URL(url).searchParams;
}

/**
 * Look up a query parameter's definition in endpoints.json.
 *
 * @param {string} operationId
 * @param {string} paramName
 * @returns {object|undefined}
 */
function queryParamDef(operationId, paramName) {
    var endpoint = MerakiDashboardApi.getEndpoint(operationId);
    assert.ok(endpoint, 'operation not present in endpoints.json: ' + operationId);
    return endpoint.params.filter(function (paramDef) {
        return paramDef.in === 'query' && paramDef.name === paramName;
    })[0];
}

/**
 * Derive, from endpoints.json alone, every (operationId, paramName) pair that is a required query
 * parameter of declared type array. Nothing here is hardcoded.
 *
 * @returns {string[]} 'operationId :: paramName' strings, sorted for a stable diff
 */
function derivedRequiredArrayOccurrences() {
    var occurrences = [];
    MerakiDashboardApi.getEndpoints().forEach(function (endpoint) {
        endpoint.params.forEach(function (paramDef) {
            if (paramDef.in === 'query' && paramDef.type === 'array' && paramDef.required) {
                occurrences.push(endpoint.operationId + ' :: ' + paramDef.name);
            }
        });
    });
    return occurrences.sort();
}

/**
 * Assert that a captured URL carries `name` in the accepted bracket-suffixed shape for exactly the
 * given elements, and carries no bare pair for it.
 *
 * @param {string} url - the URL the stubbed fetch was called with
 * @param {string} name - the query parameter name, unbracketed
 * @param {Array} elements - expected element values in caller order
 */
function assertAcceptedShape(url, name, elements) {
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
        'suffix should reach the wire as %5B%5D, the form the live-API evidence table confirms: ' + url
    );
    assert.strictEqual(
        url.indexOf('%5B%5D%5B%5D'),
        -1,
        'never double-bracketed - the API rejects that too: ' + url
    );
}

describe('Required-array operations: 7 of 8 become reachable (2.4 partial, 2.7)', function () {
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

    describe('the required-array set derived from endpoints.json', function () {

        it('is exactly the 8 operations / 9 occurrences this file accounts for', function () {
            // Both sides of this comparison describe the same fact from opposite directions: the
            // left is read out of endpoints.json, the right is what the tests below assume. If a
            // regenerated endpoints.json adds a required array parameter, this fails with a
            // readable diff rather than letting the new parameter go untested.
            var expected = NEWLY_REACHABLE.map(function (entry) {
                return entry.operationId + ' :: ' + entry.requiredArray;
            }).concat([
                STAYS_UNREACHABLE.operationId + ' :: ' + STAYS_UNREACHABLE.fixedRequiredArray,
                STAYS_UNREACHABLE.operationId + ' :: ' + STAYS_UNREACHABLE.unfixedRequiredArray
            ]).sort();

            assert.deepStrictEqual(
                derivedRequiredArrayOccurrences(),
                expected,
                'the set of required declared-array query parameters in endpoints.json has changed; ' +
                'update this spec deliberately rather than loosening the assertion'
            );
        });

        it('spans 8 distinct operations, of which 7 are claimed fixed and 1 is not', function () {
            var operationIds = {};
            derivedRequiredArrayOccurrences().forEach(function (occurrence) {
                operationIds[occurrence.split(' :: ')[0]] = true;
            });

            assert.strictEqual(Object.keys(operationIds).length, 8, 'expected 8 affected operations');
            assert.strictEqual(NEWLY_REACHABLE.length, 7, 'expected 7 to become reachable, not 8');

            // The 9th occurrence exists because one operation contributes two required arrays,
            // which is precisely why 8 operations do not yield 8 fixes.
            assert.strictEqual(derivedRequiredArrayOccurrences().length, 9);
        });
    });

    describe('the 7 newly-reachable operations produce accepted-shape URLs', function () {

        NEWLY_REACHABLE.forEach(function (entry) {

            describe(entry.operationId, function () {

                it('declares ' + entry.requiredArray + ' as a required query array in endpoints.json', function () {
                    // Verified, not trusted: if endpoints.json disagrees with this file's table,
                    // that is a discrepancy to report, not something to paper over.
                    var paramDef = queryParamDef(entry.operationId, entry.requiredArray);
                    assert.ok(paramDef, entry.requiredArray + ' should be a query parameter of ' + entry.operationId);
                    assert.strictEqual(paramDef.type, 'array', entry.requiredArray + ' should be declared type array');
                    assert.strictEqual(paramDef.required, true, entry.requiredArray + ' should be required');
                });

                it('brackets ' + entry.requiredArray + ' when given an array of scalars', function () {
                    var parameters = Object.assign({}, entry.otherParameters);
                    parameters[entry.requiredArray] = entry.elements;

                    return api.callEndpoint(entry.operationId, parameters).then(function () {
                        assert.strictEqual(capture.count, 1, 'exactly one request should have been made');
                        assertAcceptedShape(capture.url, entry.requiredArray, entry.elements);
                    });
                });

                it('brackets ' + entry.requiredArray + ' when given a bare scalar (the Node-RED text-field shape)', function () {
                    // examples.json types array parameters as `str` text fields, so the Node-RED
                    // node's real-world value for a required array is a single scalar. Rule 4
                    // treats a scalar as a one-element array, which is what makes that path work.
                    var parameters = Object.assign({}, entry.otherParameters);
                    parameters[entry.requiredArray] = entry.elements[0];

                    return api.callEndpoint(entry.operationId, parameters).then(function () {
                        assert.strictEqual(capture.count, 1, 'exactly one request should have been made');
                        assertAcceptedShape(capture.url, entry.requiredArray, [entry.elements[0]]);
                    });
                });

                it('leaves the operation\'s non-array query parameters bare', function () {
                    // The whole point of the type-driven rule is that it brackets the declared
                    // arrays and nothing else. Any declared scalar on the same call must still go
                    // on the wire in its pre-fix bare form (3.1).
                    var endpoint = MerakiDashboardApi.getEndpoint(entry.operationId);
                    var scalarNames = [];
                    var parameters = Object.assign({}, entry.otherParameters);
                    parameters[entry.requiredArray] = entry.elements;

                    endpoint.params.forEach(function (paramDef) {
                        if (paramDef.in !== 'query' || paramDef.type === 'array') {
                            return;
                        }
                        scalarNames.push(paramDef.name);
                        parameters[paramDef.name] = paramDef.type === 'integer' ? 10
                            : paramDef.type === 'number' ? 86400
                                : paramDef.type === 'boolean' ? false
                                    : 'scalar value';
                    });

                    return api.callEndpoint(entry.operationId, parameters).then(function () {
                        var params = queryOf(capture.url);
                        scalarNames.forEach(function (name) {
                            assert.strictEqual(
                                params.getAll(name).length,
                                1,
                                name + ' should emit exactly one bare pair: ' + capture.url
                            );
                            assert.deepStrictEqual(
                                params.getAll(name + '[]'),
                                [],
                                name + ' is not a declared array and must not be bracketed: ' + capture.url
                            );
                        });
                        // And the required array is still bracketed alongside them.
                        assertAcceptedShape(capture.url, entry.requiredArray, entry.elements);
                    });
                });
            });
        });
    });

    describe('KNOWN LIMITATION, NOT FIXED - getOrganizationCameraDetectionsHistoryByBoundaryByInterval', function () {

        it('confirms endpoints.json still declares BOTH boundaryIds and ranges as required arrays', function () {
            // This is the structural reason the operation cannot be fixed by this change: two
            // required arrays, and only one of them takes scalar elements.
            var boundaryIds = queryParamDef(STAYS_UNREACHABLE.operationId, STAYS_UNREACHABLE.fixedRequiredArray);
            var ranges = queryParamDef(STAYS_UNREACHABLE.operationId, STAYS_UNREACHABLE.unfixedRequiredArray);

            assert.ok(boundaryIds, 'boundaryIds should be a query parameter');
            assert.strictEqual(boundaryIds.type, 'array');
            assert.strictEqual(boundaryIds.required, true);

            assert.ok(ranges, 'ranges should be a query parameter');
            assert.strictEqual(ranges.type, 'array');
            assert.strictEqual(ranges.required, true, 'ranges being required is what keeps the operation unreachable');
        });

        it('stays UNREACHABLE, but now fails with a clear error naming ranges instead of emitting a malformed URL - fixing boundaryIds is necessary but not sufficient', function () {
            // ---------------------------------------------------------------------------------
            // THIS TEST DOCUMENTS A KNOWN LIMITATION. IT IS NOT A PASSING FIX FOR `ranges`.
            //
            // `ranges` on getOrganizationCameraDetectionsHistoryByBoundaryByInterval is an array
            // whose elements the API expects to be OBJECTS. The OpenAPI spec declares the element
            // shape (startTime, endTime, interval) but NOT the query-string wire format for object
            // elements, and no candidate encoding has been verified against the live API, so this
            // client deliberately does not implement one.
            //
            // What changed: rule 4 used to bracket the key like any other declared array and let
            // URLSearchParams stringify each object via String(), yielding the literal text
            // `[object Object]` (`ranges%5B%5D=%5Bobject+Object%5D` on the wire) and a confusing
            // 400 from the API. It now throws an explicit, actionable error naming the parameter,
            // surfaced as a promise rejection, and makes no request at all. The malformed-URL
            // assertion this test used to carry is therefore wrong by design and has been replaced
            // with the assertions below.
            //
            // What did NOT change: `ranges` is still not encodable, and it is `required` ALONGSIDE
            // `boundaryIds`, so there is still no argument a caller can pass that produces a
            // request the API accepts. Fixing `boundaryIds` - which the last assertion in the test
            // below shows does work - is NECESSARY BUT NOT SUFFICIENT. This operation stays
            // unreachable, which is why requirement 2.4's "all 8" is an overstatement and the real
            // outcome is 7 of 8. Nothing here should be cited as evidence that `ranges` works.
            // ---------------------------------------------------------------------------------
            var parameters = Object.assign({}, STAYS_UNREACHABLE.otherParameters);
            parameters[STAYS_UNREACHABLE.fixedRequiredArray] = ['boundary-1', 'boundary-2'];
            parameters[STAYS_UNREACHABLE.unfixedRequiredArray] = [
                { startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z', interval: 3600 }
            ];

            // A synchronous throw here would escape the promise chain and bypass every consumer's
            // .catch(), so the shape of the failure is asserted as well as its presence.
            var returned;
            assert.doesNotThrow(function () {
                returned = api.callEndpoint(STAYS_UNREACHABLE.operationId, parameters);
            }, 'the failure must not be a synchronous throw out of callEndpoint');
            assert.ok(returned && typeof returned.then === 'function', 'callEndpoint should return a promise');

            return returned.then(function () {
                assert.fail('expected a rejection for the unencodable object elements in ranges');
            }, function (err) {
                assert.ok(err instanceof Error, 'the rejection reason should be an Error');
                assert.ok(
                    err.message.indexOf('ranges') !== -1,
                    'the error must name the offending parameter, got: ' + err.message
                );
                assert.ok(
                    /scalar/.test(err.message),
                    'the error should say what is required instead, got: ' + err.message
                );
                assert.strictEqual(
                    capture.count,
                    0,
                    'no request may be made - the old behavior sent a malformed URL, this one sends nothing'
                );
            });
        });

        it('serializes boundaryIds correctly on its own, which is the "necessary but not sufficient" half', function () {
            // Same operation, with `ranges` given scalar elements purely so a URL can be built.
            // That is not a legal call to the real API - it only isolates boundaryIds to show the
            // half of the fix that does work.
            var parameters = Object.assign({}, STAYS_UNREACHABLE.otherParameters);
            parameters[STAYS_UNREACHABLE.fixedRequiredArray] = ['boundary-1', 'boundary-2'];
            parameters[STAYS_UNREACHABLE.unfixedRequiredArray] = ['not-a-real-range'];

            return api.callEndpoint(STAYS_UNREACHABLE.operationId, parameters).then(function () {
                assert.strictEqual(capture.count, 1, 'exactly one request should have been made');
                assertAcceptedShape(capture.url, 'boundaryIds', ['boundary-1', 'boundary-2']);
            });
        });

        it('cannot be called at all without ranges, so bracketing boundaryIds alone does not open it up', function () {
            // Omitting `ranges` does not sidestep the limitation: callEndpoint rejects on the
            // required-parameter check before any URL is built. There is no working call.
            var parameters = Object.assign({}, STAYS_UNREACHABLE.otherParameters);
            parameters[STAYS_UNREACHABLE.fixedRequiredArray] = ['boundary-1'];

            return api.callEndpoint(STAYS_UNREACHABLE.operationId, parameters).then(function () {
                assert.fail('expected a rejection for the missing required ranges parameter');
            }, function (err) {
                assert.ok(
                    /ranges/.test(err.message),
                    'rejection should name the missing required parameter, got: ' + err.message
                );
                assert.strictEqual(capture.count, 0, 'no request should have been attempted');
            });
        });
    });
});
