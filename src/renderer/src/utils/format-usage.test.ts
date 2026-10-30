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
  assert.equal(formatNumber(9999), '9,999');
});

test('formatNumber formats 万 with proper rounding', () => {
  assert.equal(formatNumber(10000), '1万');
  assert.equal(formatNumber(15000), '1.5万');
  assert.equal(formatNumber(99990), '10万');
  assert.equal(formatNumber(100000), '10万');
});

test('formatNumber keeps 万 up to 亿, no 百万 unit', () => {
  assert.equal(formatNumber(999999), '100万');
  assert.equal(formatNumber(1000000), '100万');
  assert.equal(formatNumber(1500000), '150万');
  assert.equal(formatNumber(12345678), '1235万');
  assert.equal(formatNumber(99949999), '9995万');
});

test('formatNumber upgrades 9999.995万 to 1亿 to avoid 10000万', () => {
  assert.equal(formatNumber(99999999), '1亿');
});

test('formatNumber formats 亿 with proper rounding', () => {
  assert.equal(formatNumber(100000000), '1亿');
  assert.equal(formatNumber(150000000), '1.5亿');
  assert.equal(formatNumber(1000000000), '10亿');
  assert.equal(formatNumber(9999999999), '100亿');
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
