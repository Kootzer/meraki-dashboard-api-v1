'use strict';
var lib = require('./lib.js');
var endpoints = require('./endpoints.json');

module.exports = function (RED) {

    // Build a lookup of endpoint definitions by operationId
    var endpointMap = {};
    endpoints.forEach(function (ep) {
        endpointMap[ep.operationId] = ep;
    });

    function MerakiDashboardApiNode(config) {
        RED.nodes.createNode(this, config);
        this.service = RED.nodes.getNode(config.service);
        this.method = config.method;
        this.storedParams = config.storedParams;

        var node = this;

        node.on('input', function (msg) {
            var errorFlag = false;
            var client;

            // Initialize the API client
            if (this.service && this.service.host) {
                if (msg.service && msg.service.host) {
                    client = new lib.MerakiDashboardApi({ domain: msg.service.host });
                } else {
                    client = new lib.MerakiDashboardApi({ domain: this.service.host });
                }
            } else {
                node.error('Host in configuration node is not specified.', msg);
                errorFlag = true;
            }

            // Set API key
            if (!errorFlag && this.service && this.service.credentials && this.service.credentials.secureApiKeyValue) {
                if (msg.service && msg.service.apiKey) {
                    client.setApiKey(msg.service.apiKey,
                        this.service.secureApiKeyHeaderOrQueryName, false);
                } else {
                    if (this.service.secureApiKeyIsQuery) {
                        client.setApiKey(this.service.credentials.secureApiKeyValue,
                            this.service.secureApiKeyHeaderOrQueryName, true);
                    } else {
                        client.setApiKey(this.service.credentials.secureApiKeyValue,
                            this.service.secureApiKeyHeaderOrQueryName, false);
                    }
                }
            }

            if (!errorFlag) {
                client.body = msg.payload || {};
            }

            // Build stored param maps
            var storedParamValsMap = {};
            var storedParamTypeMap = {};
            if (node.storedParams) {
                node.storedParams.forEach(function (p) {
                    storedParamValsMap[p.camelCaseName] = p.value;
                    storedParamTypeMap[p.camelCaseName] = p.type;
                });
            }

            // Determine which method/operationId to call
            var operationId = node.method || RED.util.getMessageProperty(msg, "operationId");

            if (!errorFlag && !operationId) {
                node.error('Method is not specified.', msg);
                errorFlag = true;
            }

            var result;

            if (!errorFlag) {
                var endpoint = endpointMap[operationId];
                if (!endpoint) {
                    node.error('Unknown API method: ' + operationId, msg);
                    errorFlag = true;
                } else {
                    // Resolve parameters generically
                    var callParams = {};

                    for (var i = 0; i < endpoint.params.length; i++) {
                        var paramDef = endpoint.params[i];
                        var paramName = paramDef.name;

                        if (paramDef.in === 'body') {
                            // Body parameter handling
                            if (msg.payload) {
                                if (typeof msg.payload === 'object') {
                                    callParams[paramName] = msg.payload;
                                } else {
                                    node.error('Unsupported type: \'' + (typeof msg.payload) + '\', msg.payload must be a JSON object or a JSON formatted string.', msg);
                                    errorFlag = true;
                                    break;
                                }
                            } else {
                                var bodyNodeParam = storedParamValsMap[paramName] ||
                                    RED.util.getMessageProperty(msg, paramName);
                                if (bodyNodeParam !== undefined) {
                                    if (typeof bodyNodeParam === 'object') {
                                        callParams[paramName] = bodyNodeParam;
                                    } else {
                                        try {
                                            var parsed = JSON.parse(bodyNodeParam || '{}');
                                            callParams[paramName] = parsed;
                                        } catch (e) {
                                            node.error('Unsupported type: \'' + (typeof bodyNodeParam) + '\', form submitted msg.payload must be a JSON string.', msg);
                                            errorFlag = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        } else {
                            // Path and query parameter handling
                            var nodeParam = storedParamValsMap[paramName] ||
                                RED.util.getMessageProperty(msg, paramName);
                            var nodeParamType = storedParamTypeMap[paramName] ||
                                RED.util.getMessageProperty(msg, paramName);

                            if (nodeParamType === 'str') {
                                callParams[paramName] = nodeParam || undefined;
                            } else {
                                callParams[paramName] = RED.util.getMessageProperty(msg, paramName);
                            }
                        }
                    }

                    if (!errorFlag) {
                        result = client.callEndpoint(operationId, callParams);
                    }
                }
            }

            // Handle missing result
            if (!errorFlag && result === undefined) {
                node.error('Method is not specified.', msg);
                errorFlag = true;
            }

            // Process the result
            var setData = function (msg, data) {
                if (data) {
                    if (data.response) {
                        if (data.response.statusCode) {
                            msg.statusCode = data.response.statusCode;
                        }
                        if (data.response.headers) {
                            msg.headers = data.response.headers;
                        }
                        if (data.response.request && data.response.request.uri && data.response.request.uri.href) {
                            msg.responseUrl = data.response.request.uri.href;
                        }
                    }
                    if (data.body) {
                        msg.payload = data.body || {};
                    }
                }
                return msg;
            };

            if (!errorFlag) {
                node.status({ fill: 'blue', shape: 'dot', text: 'MerakiDashboardApi.status.requesting' });
                result.then(function (data) {
                    node.send(setData(msg, data));
                    node.status({});
                }).catch(function (error) {
                    var message = null;
                    if (error && error.body && error.body.message) {
                        message = error.body.message;
                    } else {
                        message = error;
                    }
                    node.error(message, setData(msg, error));
                    node.status({ fill: 'red', shape: 'ring', text: 'node-red:common.status.error' });
                });
            }
        });
    }

    RED.nodes.registerType('meraki-dashboard-api-v1', MerakiDashboardApiNode);

    function MerakiDashboardApiServiceNode(n) {
        RED.nodes.createNode(this, n);
        this.host = n.host;
        this.secureApiKeyHeaderOrQueryName = n.secureApiKeyHeaderOrQueryName;
        this.secureApiKeyIsQuery = n.secureApiKeyIsQuery;
    }

    RED.nodes.registerType('meraki-dashboard-api-v1-service', MerakiDashboardApiServiceNode, {
        credentials: {
            secureApiKeyValue: { type: 'password' },
            temp: { type: 'text' }
        }
    });
};
