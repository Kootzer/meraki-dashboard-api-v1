'use strict';

/**
 * fetch stubbing helper for the indirect test seam.
 *
 * `buildUrlWithQuery` can be exercised directly via `lib.__buildUrlWithQuery`, but that
 * only proves the serializer. To prove that declared types are actually threaded from
 * endpoints.json through `callEndpoint` -> `request` -> `buildUrlWithQuery`, tests need
 * to drive a real `callEndpoint` call and inspect the URL that would have gone on the
 * wire. This module replaces `global.fetch` with a stub that captures that URL and
 * resolves a minimal Response-shaped object, so no network traffic is ever generated.
 *
 * NOTE ON THE FILENAME: mocha is configured with the glob "test/**\/*_spec.js". This file
 * deliberately does NOT match that pattern, so mocha will not load it as a suite. Keep it
 * that way - do not rename it to *_spec.js.
 *
 * Usage:
 *
 *   var fetchStub = require('./helpers/fetchStub');
 *
 *   describe('...', function () {
 *       var capture;
 *       beforeEach(function () { capture = fetchStub.install(); });
 *       afterEach(function () { fetchStub.restore(); });
 *
 *       it('...', function () {
 *           return api.callEndpoint('getOrganizationDevices', { organizationId: '1' })
 *               .then(function () {
 *                   assert.ok(capture.url.indexOf('...') !== -1);
 *               });
 *       });
 *   });
 */

// Sentinel so restore() can tell "global.fetch was absent" from "global.fetch was undefined".
var NOT_INSTALLED = {};
var savedFetch = NOT_INSTALLED;
var hadOwnFetch = false;

/**
 * Build a minimal object with the surface `MerakiDashboardApi.prototype.request` consumes:
 * `status`, `headers.get()`, `headers.entries()`, `json()` and `url`.
 *
 * @param {string} url - the URL the stub was called with, echoed back as `response.url`
 * @param {object} [options] - { status, contentType, json }
 * @returns {object} a Response-shaped object
 */
function makeResponse(url, options) {
    var opts = options || {};
    var status = opts.status === undefined ? 200 : opts.status;
    var contentType = opts.contentType === undefined ? 'application/json' : opts.contentType;
    var jsonBody = opts.json === undefined ? [] : opts.json;

    var headerPairs = contentType === null ? [] : [['content-type', contentType]];

    return {
        status: status,
        url: url,
        headers: {
            get: function (name) {
                var wanted = String(name).toLowerCase();
                for (var i = 0; i < headerPairs.length; i++) {
                    if (headerPairs[i][0] === wanted) {
                        return headerPairs[i][1];
                    }
                }
                return null;
            },
            entries: function () {
                return headerPairs[Symbol.iterator]();
            }
        },
        json: function () {
            return Promise.resolve(jsonBody);
        },
        text: function () {
            return Promise.resolve(typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody));
        }
    };
}

/**
 * Replace `global.fetch` with a capturing stub.
 *
 * @param {object} [options] - response overrides: { status, contentType, json }
 * @returns {{url: (string|undefined), urls: string[], options: (object|undefined), calls: object[], count: number}}
 *          `url` / `options` reflect the most recent call; `calls` holds every call in order.
 */
function install(options) {
    if (savedFetch === NOT_INSTALLED) {
        hadOwnFetch = Object.prototype.hasOwnProperty.call(global, 'fetch');
        savedFetch = global.fetch;
    }

    var capture = {
        url: undefined,
        urls: [],
        options: undefined,
        calls: [],
        count: 0
    };

    global.fetch = function (url, fetchOptions) {
        capture.url = url;
        capture.urls.push(url);
        capture.options = fetchOptions;
        capture.calls.push({ url: url, options: fetchOptions });
        capture.count = capture.calls.length;
        return Promise.resolve(makeResponse(url, options));
    };

    return capture;
}

/**
 * Restore whatever `global.fetch` was before `install()`. Safe to call when not installed.
 */
function restore() {
    if (savedFetch === NOT_INSTALLED) {
        return;
    }
    if (hadOwnFetch) {
        global.fetch = savedFetch;
    } else {
        delete global.fetch;
    }
    savedFetch = NOT_INSTALLED;
    hadOwnFetch = false;
}

module.exports = {
    install: install,
    restore: restore,
    makeResponse: makeResponse
};
