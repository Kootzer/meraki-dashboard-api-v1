/**
 * Build script: Injects endpoints.json data into node.html
 * 
 * Run this after modifying endpoints.json to update the node editor.
 * Usage: node build.js
 */
const fs = require('fs');
const path = require('path');

const endpointsPath = path.join(__dirname, 'endpoints.json');
const htmlTemplatePath = path.join(__dirname, 'node.html.template');
const htmlOutputPath = path.join(__dirname, 'node.html');

// Read endpoints
const endpoints = JSON.parse(fs.readFileSync(endpointsPath, 'utf8'));
console.log(`Loaded ${endpoints.length} endpoints`);

// Read the HTML template (or current node.html if template doesn't exist)
let templatePath = fs.existsSync(htmlTemplatePath) ? htmlTemplatePath : htmlOutputPath;
let html = fs.readFileSync(templatePath, 'utf8');

// Replace the placeholder with actual endpoint data
const endpointsJson = JSON.stringify(endpoints);
html = html.replace('ENDPOINTS_PLACEHOLDER', endpointsJson);

// Write the final node.html
fs.writeFileSync(htmlOutputPath, html, 'utf8');

const stats = fs.statSync(htmlOutputPath);
console.log(`Written node.html (${(stats.size / 1024).toFixed(1)} KB)`);
console.log('Done!');
