import { createHash } from 'node:crypto'
import { blake3 } from '@noble/hashes/blake3.js'
import type { GitObjectType, Hex } from './types.ts'

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

export function hexToBytes(hex: Hex | string): Uint8Array {
  const value = hex.startsWith('0x') ? hex.slice(2) : hex
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Invalid hex value: ${hex}`)
  }
  return new Uint8Array(Buffer.from(value, 'hex'))
}

export function sha256(bytes: Uint8Array | string): Hex {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`
}

export function sha1(bytes: Uint8Array | string): Hex {
  return `0x${createHash('sha1').update(bytes).digest('hex')}`
}

export function blake3Hash(bytes: Uint8Array): Hex {
  return bytesToHex(blake3(bytes))
}

export function gitObjectBytes(type: GitObjectType, payload: Uint8Array): Uint8Array {
  const header = Buffer.from(`${type} ${payload.byteLength}\0`)
  return new Uint8Array(Buffer.concat([header, Buffer.from(payload)]))
}

export function dithubOid(type: GitObjectType, payload: Uint8Array): Hex {
  return sha256(gitObjectBytes(type, payload))
}

export function gitOid(type: GitObjectType, payload: Uint8Array, algorithm: 'sha1' | 'sha256'): Hex {
  const bytes = gitObjectBytes(type, payload)
  return algorithm === 'sha1' ? sha1(bytes) : sha256(bytes)
}

export function toBytes32GitOid(oid: string): Hex {
  const clean = oid.startsWith('0x') ? oid.slice(2) : oid
  if (![40, 64].includes(clean.length) || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error(`Unsupported Git OID: ${oid}`)
  }
  return `0x${clean.padStart(64, '0').toLowerCase()}`
}
