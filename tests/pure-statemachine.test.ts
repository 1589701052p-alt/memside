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
})

test('rejected can return to candidate (restore)', () => {
  expect(canTransition('rejected', 'candidate')).toBe(true)
})

test('superseded stays terminal', () => {
  expect(canTransition('superseded', 'approved')).toBe(false)
  expect(canTransition('superseded', 'candidate')).toBe(false)
})

test('candidate cannot jump to archived', () => {
  expect(canTransition('candidate', 'archived')).toBe(false)
})

test('pending_review can go candidate / approved / rejected (spec §6.4 手动接管)', () => {
  expect(canTransition('pending_review', 'candidate')).toBe(true)
  expect(canTransition('pending_review', 'approved')).toBe(true)
  expect(canTransition('pending_review', 'rejected')).toBe(true)
})

test('pending_review cannot jump to archived / superseded', () => {
  expect(canTransition('pending_review', 'archived')).toBe(false)
  expect(canTransition('pending_review', 'superseded')).toBe(false)
})
