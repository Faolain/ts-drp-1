import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
assert.ok(input && output);
const bytes = readFileSync(input);
const records = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
function aggregate(rows, group) {
  const totals = new Map();
  for (const row of rows) {
    const key = group(row);
    const value = totals.get(key) ?? { key, rows: 0, logicalPayloadBytes: 0 };
    value.rows += row.rows;
    value.logicalPayloadBytes += row.logicalPayloadBytes;
    totals.set(key, value);
  }
  return [...totals.values()].sort((a, b) => b.logicalPayloadBytes - a.logicalPayloadBytes);
}
const memory = records.filter(row => row.kind === 'transition-memory' && !row.terminalAccounting);
const tail = memory.filter(row => row.transitions >= 10 && row.transitions <= 30);
function slope(field) {
  assert.equal(tail.length, 21, 'all transition10-through30 memory rows required');
  const meanX = tail.reduce((sum, row) => sum + row.transitions, 0) / tail.length;
  const meanY = tail.reduce((sum, row) => sum + row.memory[field], 0) / tail.length;
  return tail.reduce((sum, row) => sum + (row.transitions - meanX) * (row.memory[field] - meanY), 0)
    / tail.reduce((sum, row) => sum + (row.transitions - meanX) ** 2, 0);
}
const snapshots = records.filter(row => row.kind === 'snapshot-complete');
assert.deepEqual(snapshots.map(row => row.transitions), [10, 20, 30]);
const boundaryCensuses = records.filter(row => row.kind === 'storage-census'
  && !row.terminalAccounting && [10, 20, 30].includes(row.transitions));
assert.equal(boundaryCensuses.length, 3);
const summary = {
  input, inputSha256: createHash('sha256').update(bytes).digest('hex'),
  captureComplete: records.some(row => row.kind === 'capture-complete'),
  terminalAccountingSeen: records.some(row => row.kind === 'storage-census' && row.terminalAccounting),
  definitions: {
    logicalPayloadBytes: 'UTF-8 string values and binary leaves; no object overhead; not actual retained heap',
    memory: 'heapUsed/external/arrayBuffers/RSS separate; arrayBuffers is a subset of external; ownedBytes=heapUsed+arrayBuffers',
    slope: 'OLS of pre-capture post-GC process counters, transitions10..30 inclusive; profiling only, NOT acceptance or the unprofiled tail32 metric',
  },
  worker: records.find(row => row.kind === 'worker-identity'),
  snapshots,
  profileSlope10to30: Object.fromEntries(['heapUsed','external','arrayBuffers','rss','ownedBytes'].map(field => [field, slope(field)])),
  boundaries: boundaryCensuses.map(row => ({
    transitions: row.transitions, totalDatabaseCount: row.totalDatabaseCount, owners: row.owners,
    totals: aggregate(row.stores, () => 'all-physical-stores')[0],
    byStoreAndStatus: aggregate(row.stores, r => [r.database.split('--')[1] ?? 'primary', r.store, r.retentionStatus].join(':')),
    byEpochAndStatus: aggregate(row.stores, r => [r.epoch, r.retentionStatus].join(':')),
  })),
};
writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, captureComplete: summary.captureComplete, profileSlope10to30: summary.profileSlope10to30 }));
