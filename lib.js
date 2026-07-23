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
 * Build a URL with query parameters appended
 * @param {string} baseUrl - the base URL (domain + path)
 * @param {object} queryParameters - key/value pairs, values may be arrays
 * @returns {string}
 */
function buildUrlWithQuery(baseUrl, queryParameters) {
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
 * HTTP Request
 * @param {string} method - http method
 * @param {string} url - url to do request
 * @param {object} body - body parameters / object
 * @param {object} headers - header parameters
 * @param {object} queryParameters - querystring parameters
 * @returns {Promise<{response: object, body: *}>}
 */
MerakiDashboardApi.prototype.request = function (method, url, body, headers, queryParameters) {
    var fullUrl = buildUrlWithQuery(url, queryParameters);

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

    // Merge any extra query parameters
    if (parameters.$queryParameters) {
        Object.keys(parameters.$queryParameters).forEach(function (parameterName) {
            queryParameters[parameterName] = parameters.$queryParameters[parameterName];
        });
    }

    return this.request(endpoint.method, domain + path, body, headers, queryParameters);
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

module.exports = { MerakiDashboardApi: MerakiDashboardApi };
