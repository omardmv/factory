// node agents/test-launch.mjs
import assert from 'node:assert/strict';
import { launchArgs, projectImageTag } from './launch.mjs';

const projects = { shop: { repo: 'o/shop' }, sayra: { repo: 'o/sayra', image: 'factory-agent-sayra:latest' }, evil: { image: 'x; rm -rf /' } };
const base = { projects, defaultImage: 'factory-agent:latest', brainDir: '/b', exists: () => true };
let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };

test('default: no image set -> default image', () => assert.equal(launchArgs({ ...base, project: 'shop' }).image, 'factory-agent:latest'));
test('custom image is used', () => assert.equal(launchArgs({ ...base, project: 'sayra' }).image, 'factory-agent-sayra:latest'));
test('knowledge dir mounted read-only', () => assert.deepEqual(launchArgs({ ...base, project: 'sayra' }).mounts, ['/b/projects/sayra/knowledge:/factory/brain/project:ro']));
test('no knowledge dir -> no mount', () => assert.deepEqual(launchArgs({ ...base, project: 'sayra', exists: () => false }).mounts, []));
test('unknown project -> default, no mount', () => assert.deepEqual(launchArgs({ ...base, project: 'nope' }), { image: 'factory-agent:latest', mounts: [] }));
test('inherited names are unknown', () => assert.deepEqual(launchArgs({ ...base, project: 'constructor' }), { image: 'factory-agent:latest', mounts: [] }));
test('path-like project name never mounts', () => assert.deepEqual(launchArgs({ ...base, projects: { '../x': {} }, project: '../x' }).mounts, []));
test('malformed image falls back', () => assert.equal(launchArgs({ ...base, project: 'evil' }).image, 'factory-agent:latest'));
test('image tag convention', () => assert.equal(projectImageTag('sayra'), 'factory-agent-sayra:latest'));
console.log(`${n} passed`);
