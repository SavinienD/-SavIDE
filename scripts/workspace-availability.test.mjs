import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

// Execute the actual TypeScript helper, not a duplicated implementation.
const source = readFileSync(new URL('../src/components/cloud/workspaceAvailability.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } });
const { workspaceUnavailable } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('old server: filesystem and Git RPC are explained', () => {
  for (const rpc of ['fs.root', 'fs.list', 'git.status']) {
    const result = workspaceUnavailable(`protocol error: unknown method ${rpc}`);
    assert.match(result.title, /Serveur joignable/);
    assert.match(result.description, /Réinstaller l’application ne suffit pas/);
  }
});
test('unconfigured workspace is distinct from old server', () => {
  assert.equal(workspaceUnavailable('protocol error: workspace root is not configured').title, 'Espace de travail non configuré');
});
test('transport and unknown errors do not claim the server is reachable or expose raw details', () => {
  for (const error of ['connection refused', 'unknown method sessions.list', 'private-path sentinel', '']) {
    const result = workspaceUnavailable(error);
    assert.equal(result.title, 'Espace distant indisponible');
    assert.ok(!result.description.includes('sentinel'));
  }
});
