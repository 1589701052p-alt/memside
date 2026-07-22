import { test, expect } from 'bun:test'
import { canTransition } from '@/memory/pure'

test('candidate can be approved/rejected', () => {
  expect(canTransition('candidate', 'approved')).toBe(true)
  expect(canTransition('candidate', 'rejected')).toBe(true)
})

test('approved can be archived or superseded', () => {
  expect(canTransition('approved', 'archived')).toBe(true)
  expect(canTransition('approved', 'superseded')).toBe(true)
})

test('archived can return to approved (unarchive)', () => {
  expect(canTransition('archived', 'approved')).toBe(true)
})

test('terminal states cannot leave', () => {
  expect(canTransition('superseded', 'approved')).toBe(false)
  expect(canTransition('rejected', 'candidate')).toBe(false)
})

test('candidate cannot jump to archived', () => {
  expect(canTransition('candidate', 'archived')).toBe(false)
})
