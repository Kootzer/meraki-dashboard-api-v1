'use strict';

var endpoints = require('./endpoints.json');

/**
 * Cisco Meraki Dashboard API v1 - Generic Client
 * Driven by endpoints.json data file.
 *
 * @class MerakiDashboardApi
 * @param {(string|object)} [options] - Domain string or options object
 */
function MerakiDashboardApi(options) {
    var domain = (typeof options === 'object') ? options.domain : options;
    this.domain = domain ? domain : 'https://api.meraki.com/api/v1';
    if (this.domain.length === 0) {
        throw new Error('Domain parameter must be specified as a string.');
    }
    this.apiKey = (typeof options === 'object') ? (options.apiKey ? options.apiKey : {}) : {};
}

/**
 * Set Api Key
 * @param {string} value - apiKey's value
 * @param {string} headerOrQueryName - the header or query name to send the apiKey at
 * @param {boolean} isQuery - true if send the apiKey as query param
 */
MerakiDashboardApi.prototype.setApiKey = function (value, headerOrQueryName, isQuery) {
    this.apiKey.value = value;
    this.apiKey.headerOrQueryName = headerOrQueryName;
    this.apiKey.isQuery = isQuery;
};

/**
 * Set Auth headers
 * @param {object} headerParams - headers object
 */
MerakiDashboardApi.prototype.setAuthHeaders = function (headerParams) {
    var headers = headerParams ? headerParams : {};
    if (!this.apiKey.isQuery && this.apiKey.headerOrQueryName) {
        headers[this.apiKey.headerOrQueryName] = this.apiKey.value;
    }
    return headers;
};

/**
 * Build a URL with query parameters appended.
 *
 * Parameters the Meraki Dashboard API declares as `"type": "array"` must be sent with the
 * bracket-suffixed convention (`productTypes[]=appliance`); the bare repeated-pair form is
 * rejected with HTTP 400. The declared type is not inferable from the runtime value, since a
 * declared array may legitimately arrive as a scalar, so it is supplied separately via
 * queryParamTypes. Every append goes through URLSearchParams, which percent-encodes the `[]`
 * suffix to `%5B%5D` - a form the API accepts and honours identically.
 *
 * The per-key rules are evaluated in a fixed order, and the order is part of the specification:
 *
 *   1. value is null/undefined                  -> skip the key
 *   2. value is an array of length 0            -> skip the key
 *   3. key already ends with '[]'               -> append under the key unchanged
 *   4. declared type is 'array'                 -> one pair per element under key + '[]'
 *   5. declared type present and not 'array'    -> bare key (arrays as repeated bare pairs)
 *   6. no declared type, value is an array      -> one pair per element under key + '[]'
 *   7. no declared type, scalar value           -> bare key
 *
 * Rule 3 before rule 4 is load-bearing: a caller who worked around the bare-form bug by passing
 * an already-bracketed key must not be double-bracketed into `productTypes[][]`, which the API
 * rejects with 400 `Each element in 'productTypes' must be a string`.
 *
 * Rule 4 throws for non-scalar elements (objects and nested arrays). The wire encoding for such
 * elements is unspecified and unverified, so an explicit error replaces the `[object Object]`
 * nonsense URLSearchParams would otherwise emit. Only rule 4 does this; rules 3, 5, 6 and 7 keep
 * their pre-existing behavior for every value shape, including objects.
 *
 * @param {string} baseUrl - the base URL (domain + path)
 * @param {object} queryParameters - key/value pairs, values may be arrays
 * @param {object} [queryParamTypes] - map of parameter name to its declared type from
 *     endpoints.json ('array', 'string', 'integer', 'number', 'boolean'). Optional; when absent
 *     or empty, only rules 1-3, 6 and 7 can fire. A key missing from this map is treated as
 *     having no declared type, which is distinct from being declared a non-array type.
 * @returns {string}
 */
function buildUrlWithQuery(baseUrl, queryParameters, queryParamTypes) {
    var types = queryParamTypes ? queryParamTypes : {};
    var searchParams = new URLSearchParams();
    Object.keys(queryParameters).forEach(function (key) {
        var value = queryParameters[key];
        var isArrayValue = Array.isArray(value);

        // Rule 1: absent values are omitted entirely.
        if (value === undefined || value === null) {
            return;
        }

        // Rule 2: an empty array is omitted entirely - neither key= nor key[]=.
        if (isArrayValue && value.length === 0) {
            return;
        }

        // Rule 3: the key is already bracketed, so append it verbatim. Must precede rule 4.
        if (key.slice(-2) === '[]') {
            if (isArrayValue) {
                value.forEach(function (v) { searchParams.append(key, v); });
            } else {
                searchParams.append(key, value);
            }
            return;
        }

        // hasOwnProperty, not truthiness: an absent declared type (rules 6/7) has to stay
        // distinguishable from a declared non-array type (rule 5).
        var hasDeclaredType = Object.prototype.hasOwnProperty.call(types, key);
        var declaredType = hasDeclaredType ? types[key] : undefined;

        // Rule 4: declared array - one bracketed pair per element, a scalar counting as one.
        if (declaredType === 'array') {
            var elements = isArrayValue ? value : [value];
            // Non-scalar elements fail loudly rather than being serialized. The OpenAPI spec
            // declares the element SHAPE for such parameters (e.g. `ranges` on
            // getOrganizationCameraDetectionsHistoryByBoundaryByInterval is an array of objects
            // with startTime/endTime/interval) but not the query-string WIRE FORMAT for them, and
            // no candidate encoding has been verified against the live API. Passing them to
            // URLSearchParams would stringify each one to the literal text `[object Object]` and
            // produce a confusing 400, so the deliberate choice is an explicit error over a
            // silently malformed request or a guessed encoding. null/undefined elements are left
            // exactly as they behave today.
            elements.forEach(function (v, index) {
                if (typeof v === 'object' && v !== null) {
                    throw new Error(
                        'Cannot serialize query parameter \'' + key + '\': array elements must be ' +
                        'scalars (string, number or boolean), but element ' + index + ' is an ' +
                        (Array.isArray(v) ? 'array' : 'object') + '. This client does not support ' +
                        'object elements in query parameters.'
                    );
                }
            });
            elements.forEach(function (v) { searchParams.append(key + '[]', v); });
            return;
        }

        // Rule 5: declared as something other than an array - unchanged bare form, including
        // repeated bare pairs when such a parameter is handed a JavaScript array.
        if (hasDeclaredType) {
            if (isArrayValue) {
                value.forEach(function (v) { searchParams.append(key, v); });
            } else {
                searchParams.append(key, value);
            }
            return;
        }

        // Rule 6: no declared type but an array value - the caller's intent is unambiguous, so
        // bracket it. This is what covers the $queryParameters escape hatch.
        if (isArrayValue) {
            value.forEach(function (v) { searchParams.append(key + '[]', v); });
            return;
        }

        // Rule 7: no declared type, scalar value - unchanged bare form. There is no basis for
        // inferring array-ness.
        searchParams.append(key, value);
    });
    var qs = searchParams.toString();
    return qs ? (baseUrl + '?' + qs) : baseUrl;
}

/**
 * HTTP Request
 * @param {string} method - http method
 * @param {string} url - url to do request
 * @param {object} body - body parameters / object
 * @param {object} headers - header parameters
 * @param {object} queryParameters - querystring parameters
 * @param {object} [queryParamTypes] - map of query parameter name to its declared type from
 *     endpoints.json, forwarded to buildUrlWithQuery so declared arrays can be bracketed.
 *     Optional and last so existing callers that omit it keep today's behavior exactly.
 * @returns {Promise<{response: object, body: *}>}
 */
MerakiDashboardApi.prototype.request = function (method, url, body, headers, queryParameters, queryParamTypes) {
    // buildUrlWithQuery is synchronous and can throw (rule 4, non-scalar array elements). A
    // synchronous throw would escape the promise chain, so callEndpoint(...).catch(...) would not
    // see it and node.js's .catch() handler would be bypassed entirely - the error would come out
    // of the Node-RED input handler instead. Convert it to a rejection, matching callEndpoint's
    // existing `return Promise.reject(new Error('Unknown endpoint: ...'))` style.
    var fullUrl;
    try {
        fullUrl = buildUrlWithQuery(url, queryParameters, queryParamTypes);
    } catch (e) {
        return Promise.reject(e);
    }

    // Normalize header values: this client historically stored header
    // values as single-element arrays (e.g. headers['Accept'] = ['application/json']).
    // fetch requires plain string header values.
    var fetchHeaders = {};
    Object.keys(headers).forEach(function (key) {
        var value = headers[key];
        fetchHeaders[key] = Array.isArray(value) ? value[0] : value;
    });

    var fetchOptions = {
        method: method,
        headers: fetchHeaders,
        redirect: 'follow'
    };

    var hasBody = body !== undefined && body !== null &&
        !(typeof body === 'object' && !(body instanceof Buffer) && Object.keys(body).length === 0);
    if (hasBody) {
        if (typeof body === 'object' && !(body instanceof Buffer)) {
            fetchOptions.body = JSON.stringify(body);
        } else {
            fetchOptions.body = body;
        }
    }

    return fetch(fullUrl, fetchOptions).then(function (response) {
        var contentType = response.headers.get('content-type') || '';
        var isJson = /^application\/(.*\+)?json/.test(contentType);

        var bodyPromise = response.status === 204
            ? Promise.resolve(undefined)
            : (isJson ? response.json().catch(function () { return undefined; }) : response.text());

        return bodyPromise.then(function (parsedBody) {
            var responseInfo = {
                statusCode: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                request: { uri: { href: response.url } }
            };

            if (response.status >= 200 && response.status <= 299) {
                if (response.status === 204) {
                    return { response: responseInfo };
                }
                return { response: responseInfo, body: parsedBody };
            }

            var error = new Error('Request failed with status code ' + response.status);
            error.response = responseInfo;
            error.body = parsedBody;
            throw error;
        });
    });
};

/**
 * Build an index of endpoints by operationId for fast lookup
 */
var endpointMap = {};
endpoints.forEach(function (ep) {
    endpointMap[ep.operationId] = ep;
});

/**
 * Generic API call method - replaces all individual prototype methods
 * @param {string} operationId - the endpoint operation ID
 * @param {object} parameters - all parameters for the call
 * @returns {Promise<{response: object, body: *}>}
 */
MerakiDashboardApi.prototype.callEndpoint = function (operationId, parameters) {
    if (parameters === undefined) {
        parameters = {};
    }

    var endpoint = endpointMap[operationId];
    if (!endpoint) {
        return Promise.reject(new Error('Unknown endpoint: ' + operationId));
    }

    var domain = this.domain;
    var path = endpoint.path;
    var body = {};
    var queryParameters = {};
    // name -> declared type from endpoints.json, for query parameters only. This is the
    // information the old code threw away at `queryParameters[paramName] = paramValue`, which
    // left buildUrlWithQuery unable to tell a declared array from a declared scalar.
    var queryParamTypes = {};
    var headers = {};

    headers = this.setAuthHeaders(headers);
    headers['Accept'] = 'application/json';
    headers['Content-Type'] = 'application/json';

    // Process parameters based on their definition
    for (var i = 0; i < endpoint.params.length; i++) {
        var paramDef = endpoint.params[i];
        var paramName = paramDef.name;
        var paramValue = parameters[paramName];

        if (paramDef.in === 'path') {
            if (paramDef.required && paramValue === undefined) {
                return Promise.reject(new Error('Missing required  parameter: ' + paramName));
            }
            path = path.replace('{' + paramName + '}', paramValue);
        } else if (paramDef.in === 'query') {
            // Recorded unconditionally, even when the value is absent: the map describes the
            // endpoint's declaration, not the call's values, and buildUrlWithQuery only ever
            // consults it for keys that actually made it into queryParameters.
            queryParamTypes[paramName] = paramDef.type;
            if (paramValue !== undefined) {
                queryParameters[paramName] = paramValue;
            }
            if (paramDef.required && paramValue === undefined) {
                return Promise.reject(new Error('Missing required  parameter: ' + paramName));
            }
        } else if (paramDef.in === 'body') {
            if (paramValue !== undefined) {
                body = paramValue;
            }
        }
    }

    // Merge any extra query parameters. Deliberately contributes nothing to queryParamTypes:
    // escape-hatch keys have no declared type, which is what makes rules 6 and 7 fire for them.
    if (parameters.$queryParameters) {
        Object.keys(parameters.$queryParameters).forEach(function (parameterName) {
            queryParameters[parameterName] = parameters.$queryParameters[parameterName];
        });
    }

    return this.request(endpoint.method, domain + path, body, headers, queryParameters, queryParamTypes);
};

/**
 * Get the list of all available endpoints
 * @returns {Array}
 */
MerakiDashboardApi.getEndpoints = function () {
    return endpoints;
};

/**
 * Get endpoint definition by operationId
 * @param {string} operationId
 * @returns {object|undefined}
 */
MerakiDashboardApi.getEndpoint = function (operationId) {
    return endpointMap[operationId];
};

module.exports = {
    MerakiDashboardApi: MerakiDashboardApi,
    // INTERNAL TEST SEAM - NOT PUBLIC API.
    // buildUrlWithQuery is module-private by design. It is exported here under a
    // double-underscore name purely so the test suite can exercise query-string
    // assembly directly. Do not depend on this from consumer code: it is not
    // covered by semver and may change or disappear without notice.
    __buildUrlWithQuery: buildUrlWithQuery
};
