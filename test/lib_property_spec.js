'use strict';

/**
 * Property 3: Fix Checking - type-driven bracketing holds across all of endpoints.json.
 *
 * Two things live here, both derived from endpoints.json AT TEST TIME so that a regenerated
 * endpoints.json (update_from_openapi.js) is picked up without touching this file:
 *
 *   1. Property 1 at full generation width. Parameter names are drawn from every distinct
 *      declared-array query parameter name present in endpoints.json (94 today), paired with
 *      non-empty arrays of scalar strings/numbers/booleans and with bare scalars, including
 *      values that need percent-encoding (space, ':', '&', '=', '/', '#', '+', '%', non-ASCII).
 *      Every element must appear exactly once as `name[]=encoded(element)`, in caller order, and
 *      no bare `name=` pair may be emitted.
 *
 *   2. An endpoint-wide sweep. Every operation in endpoints.json is driven through callEndpoint
 *      with fetch stubbed, supplying a value for each of its query parameters according to that
 *      parameter's declared type. Every declared-array parameter must emit bracketed pairs and no
 *      other parameter may. This is what makes requirement 2.7 structural rather than an
 *      enumerated list of 94 names: nothing in this file names a parameter, so a future
 *      regeneration that adds array parameters is covered automatically.
 *
 * WHY THE ASSERTIONS PARSE THE QUERY STRING INSTEAD OF MATCHING SUBSTRINGS
 *
 * A naive `url.indexOf(name + '=') === -1` check for "no bare pair" gives false positives in three
 * ways: `networkIds=` is a substring of nothing but `ids=` is a suffix of it; `%5B%5D` decodes to
 * `[]` so the bracketed pair `productTypes%5B%5D=x` contains no literal `productTypes[]=`; and one
 * operation's parameters can be prefixes of another's. So every assertion below goes through
 * `new URL(...).searchParams`, which parses `&`-separated pairs and percent-decodes keys, making
 * `getAll('productTypes[]')` and `getAll('productTypes')` exact, unambiguous lookups.
 *
 * NON-GOAL, EXPLICITLY HANDLED - arrays whose elements are not scalars
 *
 * design.md's Non-Goals section excludes arrays of non-scalar elements. Exactly one exists:
 * `ranges` on getOrganizationCameraDetectionsHistoryByBoundaryByInterval, which the API wants as
 * an array of objects. endpoints.json declares it only as `"type": "array"` with no element type,
 * so this file cannot and does not try to generate object elements for it: the generators below
 * produce scalar elements for every declared array, `ranges` included. That keeps `ranges` inside
 * the sweep for the property the sweep actually asserts - that the KEY is bracketed - while the
 * wrong-element-encoding limitation (`ranges%5B%5D=%5Bobject+Object%5D`) is deliberately out of
 * scope here. See KNOWN_NON_SCALAR_ELEMENT_PARAMS below; task 7 owns the known-unfixed assertion
 * for it. Nothing in this file should be read as a claim that `ranges` works.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7
 */

var assert = require('assert');
var fc = require('fast-check');
var lib = require('../lib.js');
var fetchStub = require('./helpers/fetchStub');

var MerakiDashboardApi = lib.MerakiDashboardApi;
var buildUrlWithQuery = lib.__buildUrlWithQuery;

var DOMAIN = 'https://api.meraki.com/api/v1';
var BASE = DOMAIN + '/organizations/715461/devices';

// Placeholder credential and placeholder path values. fetch is stubbed, so nothing leaves the
// process; the path value only has to be inert enough that the URL still parses.
var FAKE_KEY = 'not-a-real-key';
var PATH_PLACEHOLDER = 'PLACEHOLDER';

/**
 * Declared-array query parameters whose elements are documented as non-scalar. Kept as a named
 * list rather than an inline `if` so the exclusion is visible and reviewable. These are NOT
 * skipped by the sweep - see the header comment. The list exists to document why the sweep feeds
 * them scalars.
 */
var KNOWN_NON_SCALAR_ELEMENT_PARAMS = [
    { operationId: 'getOrganizationCameraDetectionsHistoryByBoundaryByInterval', name: 'ranges' }
];

// ---------------------------------------------------------------------------
// Everything below is derived from endpoints.json at require time.
// ---------------------------------------------------------------------------

var ENDPOINTS = MerakiDashboardApi.getEndpoints();

/**
 * Every distinct query parameter name that endpoints.json declares as `"type": "array"`.
 *
 * @returns {string[]} sorted for determinism
 */
function distinctDeclaredArrayNames() {
    var seen = {};
    ENDPOINTS.forEach(function (endpoint) {
        endpoint.params.forEach(function (paramDef) {
            if (paramDef.in === 'query' && paramDef.type === 'array') {
                seen[paramDef.name] = true;
            }
        });
    });
    return Object.keys(seen).sort();
}

var ARRAY_PARAM_NAMES = distinctDeclaredArrayNames();

/**
 * Parse a built URL's query string into an exact key -> values map.
 *
 * URLSearchParams percent-decodes keys, so a `%5B%5D` suffix comes back as a literal `[]`. That is
 * what makes the bracketed/bare distinction testable by exact key lookup.
 *
 * @param {string} url
 * @returns {URLSearchParams}
 */
function queryOf(url) {
    return new URL(url).searchParams;
}

/**
 * Distinct keys present in a query string, in first-appearance order.
 *
 * @param {URLSearchParams} params
 * @returns {string[]}
 */
function distinctKeys(params) {
    var keys = [];
    params.forEach(function (value, key) {
        if (keys.indexOf(key) === -1) {
            keys.push(key);
        }
    });
    return keys;
}

// ---------------------------------------------------------------------------
// Part 1 - Property 1 at full generation width.
// ---------------------------------------------------------------------------

/**
 * Scalar element domain. Strings, numbers and booleans only: non-scalar elements are excluded per
 * Non-Goals. `fc.string()` in fast-check 4 draws printable-ASCII graphemes, so the encoding
 * hazards are added explicitly rather than hoped for.
 */
var ENCODING_HAZARDS = [
    'a b',                  // space -> '+', the URLSearchParams behavior 3.2 pins
    'a:b',                  // ':'   -> %3A
    'a&b',                  // '&'   -> %26, i.e. must not split into a second pair
    'a=b',                  // '='   -> %3D, must not split into key=value
    'a/b',                  // '/'   -> %2F
    '#frag',                // '#'   -> %23, must not start a fragment
    '100%',                 // '%'   -> %25, must not be read as an escape
    'a+b',                  // '+'   -> %2B, must round-trip back to '+' not a space
    'caf\u00e9',            // non-ASCII, 2-byte UTF-8
    '\u65e5\u672c\u8a9e',   // non-ASCII, 3-byte UTF-8
    ''                      // empty element - still one pair, `name[]=`
];

var scalarElement = fc.oneof(
    fc.string(),
    fc.constantFrom.apply(null, ENCODING_HAZARDS),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean()
);

/**
 * A bug-condition entry: a real declared-array name paired with either a non-empty array of
 * scalars or a bare scalar (the Node-RED text-field shape, which counts as one element).
 */
var bugConditionEntry = fc.record({
    name: fc.constantFrom.apply(null, ARRAY_PARAM_NAMES),
    value: fc.oneof(
        fc.array(scalarElement, { minLength: 1, maxLength: 5 }),
        scalarElement
    )
});

describe('Property 3: Fix Checking - type-driven bracketing across all of endpoints.json', function () {

    describe('endpoints.json derivation', function () {

        it('derives the declared-array name list from the file rather than hardcoding it', function () {
            assert.ok(ENDPOINTS.length > 0, 'endpoints.json should not be empty');
            assert.ok(ARRAY_PARAM_NAMES.length > 0, 'endpoints.json should declare at least one array query parameter');

            // Every derived name really is declared `array` somewhere, and nothing was invented.
            ARRAY_PARAM_NAMES.forEach(function (name) {
                var found = ENDPOINTS.some(function (endpoint) {
                    return endpoint.params.some(function (paramDef) {
                        return paramDef.in === 'query' && paramDef.type === 'array' && paramDef.name === name;
                    });
                });
                assert.ok(found, name + ' should be a declared array query parameter in endpoints.json');
            });
        });
    });

    describe('Property 1 at full generation width (2.1, 2.2, 2.3, 2.6)', function () {

        it('every element of a declared array appears exactly once as name[]=encoded(element), in order', function () {
            fc.assert(
                fc.property(bugConditionEntry, function (entry) {
                    var isArrayValue = Array.isArray(entry.value);
                    var elements = isArrayValue ? entry.value : [entry.value];

                    var queryParameters = {};
                    queryParameters[entry.name] = entry.value;
                    var types = {};
                    types[entry.name] = 'array';

                    var url = buildUrlWithQuery(BASE, queryParameters, types);
                    var params = queryOf(url);
                    var bracketed = entry.name + '[]';

                    // One pair per element, in the caller's order, values intact through encoding.
                    assert.deepStrictEqual(
                        params.getAll(bracketed),
                        elements.map(String),
                        'bracketed pairs for ' + entry.name + ' should match the elements in order'
                    );

                    // No bare pair. Exact-key lookup, so a name that is a prefix or suffix of
                    // another cannot produce a false pass or a false failure here.
                    assert.deepStrictEqual(
                        params.getAll(entry.name),
                        [],
                        'no bare ' + entry.name + '= pair should be emitted'
                    );

                    // And nothing else leaked into the query string.
                    assert.deepStrictEqual(distinctKeys(params), [bracketed]);

                    // The suffix goes on the wire percent-encoded, which is the form design.md's
                    // live-API evidence table shows Meraki honours.
                    assert.ok(
                        url.indexOf(entry.name + '%5B%5D=') !== -1,
                        'suffix should be emitted as %5B%5D: ' + url
                    );
                    assert.strictEqual(url.indexOf('%5B%5D%5B%5D'), -1, 'never double-bracketed: ' + url);
                }),
                { numRuns: 400 }
            );
        });

        it('holds for every declared-array name in endpoints.json, not just sampled ones', function () {
            var value = ['a b:c&d=e/f\u00e9', 'second'];
            ARRAY_PARAM_NAMES.forEach(function (name) {
                var queryParameters = {};
                queryParameters[name] = value;
                var types = {};
                types[name] = 'array';

                var params = queryOf(buildUrlWithQuery(BASE, queryParameters, types));
                assert.deepStrictEqual(params.getAll(name + '[]'), value, name + ' should be bracketed');
                assert.deepStrictEqual(params.getAll(name), [], name + ' should emit no bare pair');
            });
        });

        it('encodes hazardous element values character for character with the suffix left as %5B%5D (2.6)', function () {
            // Literal expectations, so this is not circular against URLSearchParams-built oracles.
            var name = ARRAY_PARAM_NAMES[0];
            var cases = [
                { element: 'a b', encoded: 'a+b' },
                { element: 'a:b', encoded: 'a%3Ab' },
                { element: 'a&b', encoded: 'a%26b' },
                { element: 'a=b', encoded: 'a%3Db' },
                { element: 'a/b', encoded: 'a%2Fb' },
                { element: '#frag', encoded: '%23frag' },
                { element: '100%', encoded: '100%25' },
                { element: 'a+b', encoded: 'a%2Bb' },
                { element: 'caf\u00e9', encoded: 'caf%C3%A9' },
                { element: '', encoded: '' }
            ];

            cases.forEach(function (testCase) {
                var queryParameters = {};
                queryParameters[name] = [testCase.element];
                var types = {};
                types[name] = 'array';

                assert.strictEqual(
                    buildUrlWithQuery(BASE, queryParameters, types),
                    BASE + '?' + name + '%5B%5D=' + testCase.encoded,
                    'element ' + JSON.stringify(testCase.element)
                );
            });
        });
    });

    // -----------------------------------------------------------------------
    // Part 2 - the endpoint-wide sweep.
    // -----------------------------------------------------------------------

    describe('endpoint-wide sweep through callEndpoint (2.7)', function () {
        var capture;
        var api;

        // Tallies, asserted against values derived from endpoints.json in a follow-up test so the
        // sweep cannot silently stop exercising things.
        var stats = {
            operations: 0,
            queryParameters: 0,
            arrayParameters: 0,
            nonArrayParameters: 0,
            failures: [],
            rejections: []
        };

        before(function () {
            // One stub and one client for all ~992 operations: installing per operation is the
            // difference between a fast sweep and a slow one.
            capture = fetchStub.install();
            api = new MerakiDashboardApi(DOMAIN);
            api.setApiKey(FAKE_KEY, 'X-Cisco-Meraki-API-Key', false);
        });

        after(function () {
            fetchStub.restore();
        });

        /**
         * A value for a query parameter, chosen by its DECLARED type. Deterministic rather than
         * random: with 992 operations the sweep's job is breadth, and Part 1 above already covers
         * value-space width for the array case.
         *
         * Array parameters get scalar elements, including one needing percent-encoding. Object
         * elements are a Non-Goal (see KNOWN_NON_SCALAR_ELEMENT_PARAMS in the header), so `ranges`
         * gets scalars here like every other declared array.
         *
         * @param {object} paramDef
         * @returns {*}
         */
        function valueForDeclaredType(paramDef) {
            switch (paramDef.type) {
                case 'array':
                    return ['sweep-one', 'sweep two&three'];
                case 'integer':
                    return 7;
                case 'number':
                    return 1.5;
                case 'boolean':
                    return true;
                default:
                    // 'string' and anything a future regeneration introduces.
                    return 'sweep value';
            }
        }

        /**
         * Build the `parameters` object for one operation: inert placeholders for path parameters
         * (so the URL builds) and a type-appropriate value for every query parameter. Body
         * parameters are left out - the sweep is about the query string.
         *
         * @param {object} endpoint
         * @returns {{parameters: object, queryParams: object[]}}
         */
        function parametersFor(endpoint) {
            var parameters = {};
            var queryParams = [];
            endpoint.params.forEach(function (paramDef) {
                if (paramDef.in === 'path') {
                    parameters[paramDef.name] = PATH_PLACEHOLDER;
                } else if (paramDef.in === 'query') {
                    parameters[paramDef.name] = valueForDeclaredType(paramDef);
                    queryParams.push(paramDef);
                }
            });
            return { parameters: parameters, queryParams: queryParams };
        }

        /**
         * Assert the captured URL for one operation: every declared-array parameter bracketed with
         * one pair per element, every other parameter bare with exactly one pair, and no other
         * keys present. Records failures instead of throwing so one bad operation does not hide
         * the rest of the sweep.
         *
         * @param {object} endpoint
         * @param {object[]} queryParams
         * @param {string} url
         */
        function checkUrl(endpoint, queryParams, url) {
            var params = queryOf(url);
            var expectedKeys = [];

            queryParams.forEach(function (paramDef) {
                var value = valueForDeclaredType(paramDef);
                var elements = Array.isArray(value) ? value : [value];

                if (paramDef.type === 'array') {
                    stats.arrayParameters++;
                    expectedKeys.push(paramDef.name + '[]');
                    try {
                        assert.deepStrictEqual(params.getAll(paramDef.name + '[]'), elements.map(String));
                        assert.deepStrictEqual(params.getAll(paramDef.name), []);
                    } catch (e) {
                        stats.failures.push(endpoint.operationId + ': declared-array ' + paramDef.name +
                            ' not bracketed - ' + url);
                    }
                } else {
                    stats.nonArrayParameters++;
                    expectedKeys.push(paramDef.name);
                    try {
                        assert.deepStrictEqual(params.getAll(paramDef.name), [String(value)]);
                        assert.deepStrictEqual(params.getAll(paramDef.name + '[]'), []);
                    } catch (e) {
                        stats.failures.push(endpoint.operationId + ': declared-' + paramDef.type + ' ' +
                            paramDef.name + ' should be bare - ' + url);
                    }
                }
                stats.queryParameters++;
            });

            var actualKeys = distinctKeys(params).sort();
            if (actualKeys.join(',') !== expectedKeys.sort().join(',')) {
                stats.failures.push(endpoint.operationId + ': unexpected query keys ' +
                    JSON.stringify(actualKeys) + ' vs ' + JSON.stringify(expectedKeys));
            }
        }

        it('brackets exactly the declared-array query parameters of every operation in endpoints.json', function () {
            // ~992 sequential callEndpoint invocations against the stub. Generous ceiling rather
            // than a tight one: this must be able to live in the default suite.
            this.timeout(120000);

            var chain = Promise.resolve();
            ENDPOINTS.forEach(function (endpoint) {
                chain = chain.then(function () {
                    var built = parametersFor(endpoint);
                    var before = capture.count;

                    return api.callEndpoint(endpoint.operationId, built.parameters).then(function () {
                        stats.operations++;
                        if (capture.count !== before + 1) {
                            stats.failures.push(endpoint.operationId + ': expected exactly one request');
                            return;
                        }
                        checkUrl(endpoint, built.queryParams, capture.url);
                    }, function (err) {
                        // Rejections are recorded, never swallowed: an operation callEndpoint
                        // refuses is an operation the sweep did not cover, and the assertion below
                        // fails on any such gap.
                        stats.rejections.push(endpoint.operationId + ': ' + err.message);
                    });
                });
            });

            return chain.then(function () {
                assert.deepStrictEqual(
                    stats.rejections,
                    [],
                    'every operation should be reachable with placeholder path values and ' +
                    'type-appropriate query values; unswept operations: ' + stats.rejections.join(' | ')
                );
                assert.deepStrictEqual(
                    stats.failures,
                    [],
                    'serialization failures:\n' + stats.failures.join('\n')
                );
                assert.strictEqual(stats.operations, ENDPOINTS.length, 'every operation should have been swept');
            });
        });

        it('exercised every query parameter declared in endpoints.json', function () {
            // Derived expectations, so a regenerated endpoints.json moves both sides together.
            var expectedQuery = 0;
            var expectedArray = 0;
            ENDPOINTS.forEach(function (endpoint) {
                endpoint.params.forEach(function (paramDef) {
                    if (paramDef.in === 'query') {
                        expectedQuery++;
                        if (paramDef.type === 'array') {
                            expectedArray++;
                        }
                    }
                });
            });

            assert.strictEqual(stats.operations, ENDPOINTS.length);
            assert.strictEqual(stats.queryParameters, expectedQuery);
            assert.strictEqual(stats.arrayParameters, expectedArray);
            assert.strictEqual(stats.nonArrayParameters, expectedQuery - expectedArray);
        });

        it('documents the non-scalar-element Non-Goal without claiming it is fixed', function () {
            // The sweep above asserted only that `ranges` KEY is bracketed, having fed it scalar
            // elements. Its real object elements stringify to `[object Object]`, which is out of
            // scope for this design; task 7 records that limitation explicitly. This test just
            // pins that the exclusion list still describes reality, so it cannot rot silently.
            KNOWN_NON_SCALAR_ELEMENT_PARAMS.forEach(function (known) {
                var endpoint = MerakiDashboardApi.getEndpoint(known.operationId);
                assert.ok(endpoint, known.operationId + ' should still exist in endpoints.json');
                var paramDef = endpoint.params.filter(function (p) {
                    return p.in === 'query' && p.name === known.name;
                })[0];
                assert.ok(paramDef, known.operationId + ' should still declare ' + known.name);
                assert.strictEqual(paramDef.type, 'array', known.name + ' should still be declared an array');
            });
        });
    });
});
