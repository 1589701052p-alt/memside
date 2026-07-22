import { test, expect } from 'bun:test'
import { detectErrorSignals } from '@/memory/pure'

test('detects tool-call failure lines', () => {
  const r = detectErrorSignals([
    { role: 'assistant', content: 'I will run the test' },
    { role: 'tool', content: 'Error: command failed with exit code 1', isError: true },
  ])
  expect(r.toolFailures).toBe(1)
  expect(r.hasSignal).toBe(true)
})

test('detects user negation words', () => {
  const r = detectErrorSignals([
    { role: 'user', content: '不对，这样改会破坏其他地方' },
  ])
  expect(r.userNegations).toBe(1)
  expect(r.hasSignal).toBe(true)
})

test('detects repeated retry of same intent', () => {
  const r = detectErrorSignals([
    { role: 'assistant', content: 'let me try npm install' },
    { role: 'tool', content: 'failed', isError: true },
    { role: 'assistant', content: 'let me try npm install again' },
    { role: 'tool', content: 'failed', isError: true },
  ])
  expect(r.retries).toBeGreaterThanOrEqual(1)
})

test('detects explicit blame marker', () => {
  const r = detectErrorSignals([
    { role: 'user', content: 'normal message' },
    { role: 'system', content: 'memside:blame user marked an error here' },
  ])
  expect(r.blameMarkers).toBe(1)
})

test('no signal on clean conversation', () => {
  const r = detectErrorSignals([{ role: 'user', content: 'add a button' }])
  expect(r.hasSignal).toBe(false)
})
