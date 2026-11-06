import { describe, expect } from 'bun:test'
import { test } from '@chainlink/cre-sdk/test'
import { configSchema, initWorkflow } from './workflow'
import cfg from './config.staging.json'

describe('initWorkflow', () => {
  test('registers an HTTP trigger and a 15-minute cron trigger', () => {
    const config = configSchema.parse(cfg)
    expect(config.schedule).toBe('0 */15 * * * *')
    const handlers = initWorkflow(config)
    expect(handlers.length).toBe(2)
  })
})
