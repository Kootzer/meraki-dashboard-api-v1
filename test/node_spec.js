'use strict';

var assert = require('assert');
var helper = require('node-red-node-test-helper');
var node = require('../node.js');

helper.init(require.resolve('node-red'));

describe('meraki-dashboard-api-v1 node', function () {

    afterEach(function (done) {
        helper.unload().then(function () {
            done();
        });
    });

    it('should load with a name', function (done) {
        var flow = [
            { id: 'n1', type: 'meraki-dashboard-api-v1', name: 'test meraki node' }
        ];
        helper.load(node, flow, function () {
            var n1 = helper.getNode('n1');
            assert.strictEqual(n1.name, 'test meraki node');
            done();
        });
    });

    it('should error when no service is configured', function (done) {
        var flow = [
            { id: 'n1', type: 'meraki-dashboard-api-v1', name: 'test meraki node', method: 'getDevice', wires: [['n2']] },
            { id: 'n2', type: 'helper' }
        ];
        helper.load(node, flow, function () {
            var n1 = helper.getNode('n1');
            n1.on('call:error', function (call) {
                assert.ok(call.firstArg.indexOf('Host in configuration node is not specified.') !== -1);
                done();
            });
            n1.receive({ payload: {} });
        });
    });

    it('should register the service (config) node', function (done) {
        var flow = [
            {
                id: 'n2',
                type: 'meraki-dashboard-api-v1-service',
                host: 'https://api.meraki.com/api/v1',
                secureApiKeyHeaderOrQueryName: 'X-Cisco-Meraki-API-Key'
            }
        ];
        helper.load(node, flow, function () {
            var n2 = helper.getNode('n2');
            assert.strictEqual(n2.host, 'https://api.meraki.com/api/v1');
            done();
        });
    });
});
