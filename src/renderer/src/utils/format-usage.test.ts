import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, formatDuration, formatTPS } from './format-usage.ts';

test('formatNumber handles null and zero', () => {
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(0), '0');
});

test('formatNumber formats small numbers without units', () => {
  assert.equal(formatNumber(1), '1');
  assert.equal(formatNumber(999), '999');
});

test('formatNumber formats K with proper rounding', () => {
  assert.equal(formatNumber(1000), '1K');
  assert.equal(formatNumber(1500), '1.5K');
  assert.equal(formatNumber(9999), '10K');
  assert.equal(formatNumber(10000), '10K');
});

test('formatNumber upgrades 999.95K to 1M to avoid 1000K', () => {
  assert.equal(formatNumber(999950), '1M');
  assert.equal(formatNumber(999999), '1M');
});

test('formatNumber formats M with proper rounding', () => {
  assert.equal(formatNumber(1000000), '1M');
  assert.equal(formatNumber(1500000), '1.5M');
  assert.equal(formatNumber(9999999), '10M');
  assert.equal(formatNumber(10000000), '10M');
});

test('formatNumber upgrades 999.95M to 1B to avoid 1000M', () => {
  assert.equal(formatNumber(999950000), '1B');
  assert.equal(formatNumber(999999999), '1B');
});

test('formatNumber formats B with proper rounding', () => {
  assert.equal(formatNumber(1000000000), '1B');
  assert.equal(formatNumber(1500000000), '1.5B');
  assert.equal(formatNumber(9999999999), '10B');
});

test('formatDuration handles null and zero', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(0), '0ms');
});

test('formatDuration formats milliseconds', () => {
  assert.equal(formatDuration(1), '1ms');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(999), '999ms');
});

test('formatDuration formats seconds', () => {
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(2500), '2.5s');
  assert.equal(formatDuration(9999), '10s');
  assert.equal(formatDuration(10000), '10s');
});

test('formatDuration formats minutes', () => {
  assert.equal(formatDuration(60000), '1.0min');
  assert.equal(formatDuration(65000), '1.1min');
  assert.equal(formatDuration(599999), '10min');
});

test('formatTPS handles null and zero', () => {
  assert.equal(formatTPS(null), '—');
  assert.equal(formatTPS(0), '0');
});

test('formatTPS formats low TPS with one decimal', () => {
  assert.equal(formatTPS(1), '1.0');
  assert.equal(formatTPS(3.456), '3.5');
  assert.equal(formatTPS(9.99), '10.0');
});

test('formatTPS formats high TPS as integers', () => {
  assert.equal(formatTPS(10), '10');
  assert.equal(formatTPS(12.8), '13');
  assert.equal(formatTPS(99.4), '99');
});
