'use strict';

/**
 * Property 2: Preservation - Non-array serialization is byte-identical.
 *
 * Observation-first. This file is written and run BEFORE the fix lands (task 4), because the
 * behavior it pins down is *current* behavior: you cannot capture a baseline from code that has
 * already moved. Every expectation below was observed on the unfixed implementation and recorded
 * as a literal string, so task 4.5 re-runs this same file - unmodified - as the regression gate.
 *
 * Preservation (from design.md): for any query parameter entry where isBugCondition is false, the
 * fixed buildUrlWithQuery SHALL produce exactly the same string as the original.
 *
 *   FOR ALL X WHERE NOT isBugCondition(X) DO
 *     ASSERT buildUrlWithQuery(base, X) = buildUrlWithQuery'(base, X)
 *   END FOR
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

var assert = require('assert');
var fc = require('fast-check');
var lib = require('../lib.js');

var buildUrlWithQuery = lib.__buildUrlWithQuery;

var DOMAIN = 'https://api.meraki.com/api/v1';
var ORG_ID = '715461';
var BASE = DOMAIN + '/organizations/' + ORG_ID + '/devices';

// ---------------------------------------------------------------------------
// THE PRESERVATION ORACLE - FROZEN. DO NOT "FIX". DO NOT REFACTOR.
//
// What follows is a deliberate, verbatim copy of buildUrlWithQuery as it exists in lib.js
// BEFORE the fix (lib.js lines 51-66, the two-argument form that branches only on
// Array.isArray). It is the oracle for Property 2: the fixed implementation is required to
// agree with it character for character on every non-bug input.
//
// It is therefore NOT dead code and NOT a duplicate to be deduplicated. If a future reader is
// tempted to update it to match lib.js, or to give it the third `queryParamTypes` parameter, or
// to make a failing preservation test go green - do not. The whole value of the oracle is that
// it is pinned to the pre-fix behavior. If the property fails, the fix is wrong, not the oracle.
// ---------------------------------------------------------------------------
function originalBuildUrlWithQuery(baseUrl, queryParameters) {
    var searchParams = new URLSearchParams();
    Object.keys(queryParameters).forEach(function (key) {
        var value = queryParameters[key];
        if (value === undefined || value === null) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(function (v) { searchParams.append(key, v); });
        } else {
            searchParams.append(key, value);
        }
    });
    var qs = searchParams.toString();
    return qs ? (baseUrl + '?' + qs) : baseUrl;
}

/**
 * The Bug_Condition predicate, verbatim from design.md. Preservation is defined as its complement.
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
 * NUANCE - flagged by task 2 and excluded here on purpose.
 *
 * An array value arriving through the `$queryParameters` escape hatch carries NO declared type, so
 * isBugCondition returns false for it. But design rule 6 ("no declared type, value is an array =>
 * bracket") says it MUST become bracketed after the fix, to satisfy requirement 2.5. So it is a
 * non-bug input that is nevertheless *required to change*. It is therefore NOT a preservation
 * input, and including it in the generation domain below would make Property 2 contradict rule 6
 * the moment the fix lands.
 *
 * The exclusion is exactly the set rule 6 fires on, and no wider:
 *   - empty untyped arrays stay in the domain, because rule 2 (skip empty array) is evaluated
 *     before rule 6 and drops them, matching the oracle;
 *   - untyped arrays under a name already ending in `[]` stay in the domain, because rule 3
 *     (append as-is) is evaluated before rule 6, also matching the oracle.
 *
 * @param {{name: string, value: *, declaredType: (string|undefined)}} X
 * @returns {boolean}
 */
function isRule6Input(X) {
    return X.declaredType === undefined &&
        Array.isArray(X.value) &&
        X.value.length > 0 &&
        X.name.slice(-2) !== '[]';
}

/**
 * True once task 4.1 has given buildUrlWithQuery its third `queryParamTypes` parameter.
 * Used only to gate one extra pre-fix-only fidelity check (see below); no assertion about the
 * preserved behavior itself depends on it.
 *
 * @returns {boolean}
 */
function fixHasLanded() {
    return buildUrlWithQuery.length >= 3;
}

/**
 * Run both implementations on the same input and assert they agree.
 * The type map is passed to the live function only; the oracle predates it by construction.
 *
 * @param {object} values
 * @param {object} [types]
 * @param {string} [message]
 * @returns {string} the agreed-upon output, so callers can additionally assert a literal
 */
function bothAgree(values, types, message) {
    var fromOracle = originalBuildUrlWithQuery(BASE, values);
    var fromLib = buildUrlWithQuery(BASE, values, types || {});
    assert.strictEqual(fromLib, fromOracle, message || 'live implementation diverged from the frozen oracle');
    return fromOracle;
}

describe('Property 2: Preservation - non-array serialization is byte-identical', function () {

    // -----------------------------------------------------------------------
    // Oracle fidelity. Every case below runs BOTH implementations and asserts they agree, which
    // pre-fix is a check that the frozen copy was transcribed faithfully, and post-fix is the
    // preservation assertion itself. Scoping the comparison to non-bug inputs is what lets the
    // same assertion serve both roles: those are the inputs on which the two must agree forever.
    // -----------------------------------------------------------------------
    describe('oracle fidelity', function () {

        it('the frozen oracle is a faithful copy of the current implementation on bug inputs too (pre-fix only)', function () {
            // Bug inputs are the ONE class where the oracle and the fixed implementation are
            // *supposed* to diverge, so this comparison is only meaningful while the code is still
            // unfixed - and only there does it add anything: it catches a mis-transcribed oracle
            // that happens to agree on every non-bug input. Skipped automatically once the fix
            // lands, so it can never become a false failure.
            if (fixHasLanded()) {
                this.skip();
                return;
            }

            var declaredArray = { productTypes: 'array' };
            assert.ok(isBugCondition({ name: 'productTypes', value: ['appliance', 'switch'], declaredType: 'array' }));

            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: ['appliance', 'switch'] }, declaredArray),
                originalBuildUrlWithQuery(BASE, { productTypes: ['appliance', 'switch'] }),
                'frozen oracle is not a verbatim copy of the pre-fix implementation'
            );
            assert.strictEqual(
                buildUrlWithQuery(BASE, { productTypes: 'appliance' }, declaredArray),
                originalBuildUrlWithQuery(BASE, { productTypes: 'appliance' })
            );
        });
    });

    // -----------------------------------------------------------------------
    // Observed baselines. Each literal was read off the unfixed implementation.
    // -----------------------------------------------------------------------

    // OBSERVED (unfixed): ...devices?perPage=100&startingAfter=abc&timespan=86400
    // 1206 of 1576 query parameters in endpoints.json are declared string/integer/number/boolean,
    // including every pagination and time-window parameter. None of them may gain a suffix.
    it('3.1 declared scalars serialize bare, with no bracket suffix', function () {
        var values = { perPage: 100, startingAfter: 'abc', timespan: 86400 };
        var types = { perPage: 'integer', startingAfter: 'string', timespan: 'integer' };

        var actual = bothAgree(values, types);

        assert.strictEqual(actual, BASE + '?perPage=100&startingAfter=abc&timespan=86400');
        assert.strictEqual(actual.indexOf('%5B%5D'), -1, 'no declared scalar may acquire a bracket suffix');
        assert.strictEqual(actual.indexOf('[]'), -1);
    });

    // OBSERVED (unfixed): ...devices?startingAfter=a+b
    // URLSearchParams encodes a space as '+', not '%20'. Requirement 3.2 pins the '+' form, so a
    // hand-rolled encoder in the fix would break this even though both forms are valid URLs.
    it('3.2 a space in a non-array value stays "+" and does not become %20', function () {
        var actual = bothAgree({ startingAfter: 'a b' }, { startingAfter: 'string' });

        assert.strictEqual(actual, BASE + '?startingAfter=a+b');
        assert.strictEqual(actual.indexOf('%20'), -1, 'space must serialize as "+" as it does today');
    });

    // OBSERVED (unfixed): ...devices?perPage=100
    // null and undefined are dropped before serialization; they are correct behavior, not bug
    // inputs, and stay dropped whatever the declared type is.
    it('3.3 null and undefined values are omitted entirely', function () {
        var values = { perPage: 100, startingAfter: null, endingBefore: undefined, networkIds: null, serials: undefined };
        var types = {
            perPage: 'integer',
            startingAfter: 'string',
            endingBefore: 'string',
            networkIds: 'array',
            serials: 'array'
        };

        var actual = bothAgree(values, types);

        assert.strictEqual(actual, BASE + '?perPage=100');
        assert.strictEqual(actual.indexOf('startingAfter'), -1);
        assert.strictEqual(actual.indexOf('endingBefore'), -1);
        assert.strictEqual(actual.indexOf('networkIds'), -1, 'a null declared-array value is omitted, not bracketed');
        assert.strictEqual(actual.indexOf('serials'), -1);
    });

    // OBSERVED (unfixed): ...devices?perPage=100
    // An empty array emits nothing at all - neither `macs=` nor `macs%5B%5D=`. This guards the fix
    // against an implementation that brackets first and only then checks for emptiness.
    it('3.4 an empty array is omitted entirely - neither macs= nor macs[]=', function () {
        var actual = bothAgree({ perPage: 100, macs: [] }, { perPage: 'integer', macs: 'array' });

        assert.strictEqual(actual, BASE + '?perPage=100');
        assert.strictEqual(actual.indexOf('macs='), -1, 'must not emit a bare empty pair');
        assert.strictEqual(actual.indexOf('macs%5B%5D='), -1, 'must not emit a bracketed empty pair');
        assert.strictEqual(actual.indexOf('macs'), -1);
    });

    // OBSERVED (unfixed): ...devices  (no '?', no trailing separator)
    it('3.5 when nothing survives filtering the base URL is returned with no trailing "?"', function () {
        var fromEmpty = bothAgree({}, {});
        assert.strictEqual(fromEmpty, BASE);
        assert.strictEqual(fromEmpty.indexOf('?'), -1);

        var allOmitted = bothAgree(
            { startingAfter: null, endingBefore: undefined, macs: [], networkIds: [] },
            { startingAfter: 'string', endingBefore: 'string', macs: 'array', networkIds: 'array' }
        );
        assert.strictEqual(allOmitted, BASE, 'an all-omitted object must still yield the bare base URL');
        assert.strictEqual(allOmitted.indexOf('?'), -1);
    });

    // OBSERVED (unfixed): ...devices?productTypes%5B%5D=appliance
    // A caller who already worked around the bug by pre-bracketing the key through
    // $queryParameters. The live API returns 400 "Each element in 'productTypes' must be a string"
    // for productTypes[][], so double-bracketing would break exactly the users who worked around
    // the bug. Rule 3 (key ends with '[]') must therefore be evaluated before rule 4.
    it('3.6 an already-bracketed key stays a single %5B%5D and is never double-bracketed', function () {
        var scalar = bothAgree({ 'productTypes[]': 'appliance' }, {});
        assert.strictEqual(scalar, BASE + '?productTypes%5B%5D=appliance');
        assert.strictEqual(scalar.indexOf('productTypes%5B%5D%5B%5D'), -1, 'must not double-bracket');
        assert.strictEqual(scalar.indexOf('[][]'), -1);

        // Same key with an array value, and again with a declared array type in the map - the case
        // where rules 3 and 4 both match and the ordering is load-bearing.
        var arrayValue = bothAgree({ 'productTypes[]': ['appliance', 'switch'] }, {});
        assert.strictEqual(arrayValue, BASE + '?productTypes%5B%5D=appliance&productTypes%5B%5D=switch');

        var typedToo = bothAgree({ 'productTypes[]': ['appliance', 'switch'] }, { 'productTypes[]': 'array' });
        assert.strictEqual(typedToo, BASE + '?productTypes%5B%5D=appliance&productTypes%5B%5D=switch');
        assert.strictEqual(typedToo.indexOf('%5B%5D%5B%5D'), -1);
    });

    // OBSERVED (unfixed): ...devices?includeAll=false&perPage=0&startingAfter=&timespan=86400
    // Falsy is not absent. Only null and undefined are dropped; false, 0 and '' all serialize.
    it('3.7 falsy-but-valid values survive: false, 0 and the empty string', function () {
        var values = { includeAll: false, perPage: 0, startingAfter: '', timespan: 86400 };
        var types = { includeAll: 'boolean', perPage: 'integer', startingAfter: 'string', timespan: 'integer' };

        var actual = bothAgree(values, types);

        assert.strictEqual(actual, BASE + '?includeAll=false&perPage=0&startingAfter=&timespan=86400');
    });

    // OBSERVED (unfixed): ...devices?startingAfter=a&startingAfter=b
    // THE DISCRIMINATING CASE. A parameter declared `string` that is handed a JavaScript array is
    // NOT a bug input (isBugCondition is false - the declared type is not 'array'), so Property 2
    // requires its bare repeated-pair output to survive untouched.
    //
    // This is what rules out rejected alternative A from design.md - "normalize scalars to arrays
    // in callEndpoint and bracket anything that is an array". That option makes value shape the
    // serialization trigger, which would rewrite this output to startingAfter%5B%5D=a&... and
    // break preservation. The chosen design keys on the declared type, so rule 5 keeps it bare.
    it('3.1 / Preservation Scope: a declared scalar handed an array stays bare repeated pairs', function () {
        var actual = bothAgree({ startingAfter: ['a', 'b'] }, { startingAfter: 'string' });

        assert.strictEqual(actual, BASE + '?startingAfter=a&startingAfter=b');
        assert.strictEqual(actual.indexOf('%5B%5D'), -1, 'a declared scalar must never be bracketed, whatever its runtime value');

        // Same shape at other declared scalar types, so the rule is about the declared type being
        // non-array rather than about `string` specifically.
        assert.strictEqual(
            bothAgree({ perPage: [1, 2] }, { perPage: 'integer' }),
            BASE + '?perPage=1&perPage=2'
        );
        assert.strictEqual(
            bothAgree({ includeAll: [false, true] }, { includeAll: 'boolean' }),
            BASE + '?includeAll=false&includeAll=true'
        );
    });

    // -----------------------------------------------------------------------
    // The property. Example tests cannot cover 1206 non-array parameters crossed with every value
    // shape; this can. Note honestly that while the code is unfixed the third argument is ignored,
    // so what this run establishes is the baseline plus the oracle's fidelity. Its full force
    // arrives at task 4.5, when the two implementations genuinely differ.
    // -----------------------------------------------------------------------
    describe('property over the non-bug input domain', function () {

        // Plain names and pre-bracketed names, drawn from real endpoints.json parameters.
        var nameArb = fc.constantFrom(
            'perPage', 'startingAfter', 'endingBefore', 't0', 't1', 'timespan', 'includeAll', 'name',
            'networkIds', 'serials', 'productTypes', 'macs', 'tags',
            'productTypes[]', 'networkIds[]', 'serials[]'
        );

        // The five declared types that appear on query parameters in endpoints.json, plus the
        // absent case that models a $queryParameters key.
        var declaredTypeArb = fc.constantFrom('string', 'integer', 'number', 'boolean', 'array', undefined);

        var scalarArb = fc.oneof(
            fc.string(),
            fc.constantFrom('', 'abc', 'a b', 'a b:c&d=e/f\u00e9'),
            fc.integer(),
            fc.constantFrom(0, -1, 86400),
            fc.double({ noNaN: true, noDefaultInfinity: true }),
            fc.boolean(),
            fc.constantFrom(false, true)
        );

        var valueArb = fc.oneof(
            { arbitrary: scalarArb, weight: 5 },
            { arbitrary: fc.array(scalarArb, { minLength: 1, maxLength: 3 }), weight: 3 },
            { arbitrary: fc.constant([]), weight: 1 },
            { arbitrary: fc.constantFrom(null, undefined), weight: 2 }
        );

        var entryArb = fc.record({
            name: nameArb,
            declaredType: declaredTypeArb,
            value: valueArb
        }).filter(function (X) {
            // The domain is the complement of the bug condition, minus the rule 6 inputs that are
            // required to change (see the isRule6Input comment above).
            return !isBugCondition(X) && !isRule6Input(X);
        });

        it('for all X where NOT isBugCondition(X), the live serializer equals the frozen oracle (3.1-3.7)', function () {
            fc.assert(
                fc.property(
                    fc.uniqueArray(entryArb, {
                        minLength: 1,
                        maxLength: 5,
                        selector: function (X) { return X.name; }
                    }),
                    function (entries) {
                        var values = {};
                        var types = {};
                        entries.forEach(function (X) {
                            assert.ok(!isBugCondition(X), 'generator leaked a bug input into the preservation domain');
                            values[X.name] = X.value;
                            if (X.declaredType !== undefined) {
                                types[X.name] = X.declaredType;
                            }
                        });

                        assert.strictEqual(
                            buildUrlWithQuery(BASE, values, types),
                            originalBuildUrlWithQuery(BASE, values)
                        );
                    }
                ),
                { numRuns: 2000 }
            );
        });

        it('the generated domain actually reaches every declared type and value shape', function () {
            // A property is only as good as its domain. Fail loudly if the filter above has
            // quietly starved a branch - e.g. if declared-array entries were all rejected, the
            // preservation guarantee for null/empty-array-at-type-array would be untested.
            var seenTypes = Object.create(null);
            var seenShapes = Object.create(null);

            fc.assert(
                fc.property(entryArb, function (X) {
                    seenTypes[String(X.declaredType)] = true;
                    if (X.value === null || X.value === undefined) {
                        seenShapes.absent = true;
                    } else if (Array.isArray(X.value)) {
                        seenShapes[X.value.length === 0 ? 'emptyArray' : 'nonEmptyArray'] = true;
                    } else if (X.value === false || X.value === 0 || X.value === '') {
                        seenShapes.falsyScalar = true;
                    } else {
                        seenShapes.scalar = true;
                    }
                    if (X.name.slice(-2) === '[]') {
                        seenShapes.bracketedName = true;
                    }
                    return true;
                }),
                { numRuns: 3000 }
            );

            ['string', 'integer', 'number', 'boolean', 'array', 'undefined'].forEach(function (t) {
                assert.ok(seenTypes[t], 'domain never generated declared type ' + t);
            });
            ['absent', 'emptyArray', 'nonEmptyArray', 'falsyScalar', 'scalar', 'bracketedName'].forEach(function (s) {
                assert.ok(seenShapes[s], 'domain never generated value shape ' + s);
            });
        });
    });
});
