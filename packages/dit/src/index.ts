#!/usr/bin/env bun
import { fail, main } from './cli.ts'

process.on('SIGINT', () => process.exit(130))
// A closed pipe (dit log | head) is not an error.
process.stdout.on('error', (er: NodeJS.ErrnoException) => { if (er.code === 'EPIPE') process.exit(0) })
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => process.exit(fail(err)))
