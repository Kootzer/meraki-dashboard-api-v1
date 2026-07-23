'use strict';

var request = require('request');
var Q = require('q');
var fileType = require('file-type');
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
 * HTTP Request
 * @param {string} method - http method
 * @param {string} url - url to do request
 * @param {object} parameters
 * @param {object} body - body parameters / object
 * @param {object} headers - header parameters
 * @param {object} queryParameters - querystring parameters
 * @param {object} form - form data object
 * @param {object} deferred - promise object
 */
MerakiDashboardApi.prototype.request = function (method, url, parameters, body, headers, queryParameters, form, deferred) {
    var req = {
        method: method,
        uri: url,
        qs: queryParameters,
        headers: headers,
        body: body,
        followAllRedirects: true
    };
    if (Object.keys(form).length > 0) {
        if (req.headers['Content-Type'] && req.headers['Content-Type'][0] === 'multipart/form-data') {
            delete req.body;
            var keyName = Object.keys(form)[0];
            req.formData = {
                [keyName]: {
                    value: form[keyName],
                    options: {
                        filename: (fileType(form[keyName]) != null ? 'file.' + fileType(form[keyName]).ext : 'file')
                    }
                }
            };
        } else {
            req.form = form;
        }
    }
    if (typeof (body) === 'object' && !(body instanceof Buffer)) {
        req.json = true;
    }
    request(req, function (error, response, body) {
        if (error) {
            deferred.reject(error);
        } else {
            if (/^application\/(.*\+)?json/.test(response.headers['content-type'])) {
                try {
                    body = JSON.parse(body);
                } catch (e) { }
            }
            if (response.statusCode === 204) {
                deferred.resolve({ response: response });
            } else if (response.statusCode >= 200 && response.statusCode <= 299) {
                deferred.resolve({ response: response, body: body });
            } else {
                deferred.reject({ response: response, body: body });
            }
        }
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
 * @returns {Promise}
 */
MerakiDashboardApi.prototype.callEndpoint = function (operationId, parameters) {
    if (parameters === undefined) {
        parameters = {};
    }
    var deferred = Q.defer();

    var endpoint = endpointMap[operationId];
    if (!endpoint) {
        deferred.reject(new Error('Unknown endpoint: ' + operationId));
        return deferred.promise;
    }

    var domain = this.domain;
    var path = endpoint.path;
    var body = {};
    var queryParameters = {};
    var headers = {};
    var form = {};

    headers = this.setAuthHeaders(headers);
    headers['Accept'] = ['application/json'];
    headers['Content-Type'] = ['application/json'];

    // Process parameters based on their definition
    for (var i = 0; i < endpoint.params.length; i++) {
        var paramDef = endpoint.params[i];
        var paramName = paramDef.name;
        var paramValue = parameters[paramName];

        if (paramDef.in === 'path') {
            path = path.replace('{' + paramName + '}', paramValue);
            if (paramDef.required && paramValue === undefined) {
                deferred.reject(new Error('Missing required  parameter: ' + paramName));
                return deferred.promise;
            }
        } else if (paramDef.in === 'query') {
            if (paramValue !== undefined) {
                queryParameters[paramName] = paramValue;
            }
            if (paramDef.required && paramValue === undefined) {
                deferred.reject(new Error('Missing required  parameter: ' + paramName));
                return deferred.promise;
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

    this.request(endpoint.method, domain + path, parameters, body, headers, queryParameters, form, deferred);

    return deferred.promise;
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
