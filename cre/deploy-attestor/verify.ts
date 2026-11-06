// Pure verification logic: no SDK imports, so it runs under `bun test` as well as the CRE WASM runtime.
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex as nobleHex } from '@noble/hashes/utils'

export type BuildJson = { commit: string; bundleHash: string; files: Record<string, string> }

const enc = (s: string) => new TextEncoder().encode(s)
export const sha256Hex = (b: Uint8Array): string => `0x${nobleHex(sha256(b))}`

/** Mirrors apps/web/build.ts: files sorted ascending by key, JSON.stringify with no spaces, sha256, 0x-prefixed. */
export function computeBundleHash(files: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]
  return sha256Hex(enc(JSON.stringify(sorted)))
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const isSafeFileName = (n: string) => SAFE_NAME.test(n) && n !== 'build.json'

/** Compare a build.json commit string to the registry's bytes32 commit (hex, left or right aligned, or utf8). */
export function commitMatches(buildCommit: string, registryCommit: string): boolean {
  const reg = registryCommit.toLowerCase().replace(/^0x/, '')
  const c = buildCommit.toLowerCase().replace(/^0x/, '')
  if (!c) return false
  if (/^[0-9a-f]+$/.test(c) && c.length % 2 === 0 && c.length <= 64) {
    if (reg === c.padEnd(64, '0') || reg === c.padStart(64, '0')) return true
  }
  const u = nobleHex(enc(buildCommit.toLowerCase()))
  return u.length <= 64 && (reg === u.padEnd(64, '0') || reg === u.padStart(64, '0'))
}

export type Observation = {
  commit: string
  claimedBundleHash: string
  listed: string[] // file names in build.json
  computed: Record<string, string> // name -> recomputed sha256 of the bytes actually served
  claimed: Record<string, string> // name -> hash claimed in build.json
  error?: string // set when the site could not be fetched/parsed: yields ok=false instead of skipping the attestation
}

export type Verdict = {
  ok: boolean
  recomputedBundleHash: string
  bundleMatchesRegistry: boolean
  filesMatchBuildJson: boolean
  buildJsonSelfConsistent: boolean
  commitMatches: boolean
  mismatches: string[]
}

/** Authoritative check: sha256 of the served bytes -> bundleHash must equal the registry's bundleHash. */
export function judge(obs: Observation, registry: { commit: string; bundleHash: string }): Verdict {
  const recomputedBundleHash = computeBundleHash(obs.computed)
  const mismatches: string[] = []
  if (obs.error) mismatches.push(`fetch/parse error: ${obs.error}`)
  for (const n of obs.listed) {
    if (obs.computed[n] !== (obs.claimed[n] ?? '').toLowerCase()) mismatches.push(`file ${n}: served bytes do not match build.json`)
  }
  const filesMatchBuildJson = mismatches.length === 0
  const buildJsonSelfConsistent = computeBundleHash(obs.claimed) === obs.claimedBundleHash.toLowerCase()
  if (!buildJsonSelfConsistent) mismatches.push('build.json bundleHash is not sha256 of its own files map')
  const bundleMatchesRegistry = recomputedBundleHash === registry.bundleHash.toLowerCase()
  if (!bundleMatchesRegistry) mismatches.push('recomputed bundleHash != registry bundleHash')
  return {
    ok: bundleMatchesRegistry && obs.listed.length > 0 && !obs.error,
    recomputedBundleHash,
    bundleMatchesRegistry,
    filesMatchBuildJson,
    buildJsonSelfConsistent,
    commitMatches: commitMatches(obs.commit, registry.commit),
    mismatches,
  }
}
