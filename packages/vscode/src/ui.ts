import * as vscode from 'vscode'
import { ApiError, OutOfScopeError } from './api.ts'
import { friendlyError, ProtocolError } from './core.ts'

/** Plain-language message for any error (API errors are mapped; tokens are never part of an error). */
export function describe(err: unknown, context = ''): string {
  if (err instanceof ApiError) return friendlyError({ status: err.status, message: err.message, body: err.body }, context)
  if (err instanceof OutOfScopeError || err instanceof ProtocolError) return context ? `${context}: ${err.message}` : err.message
  const m = err instanceof Error ? err.message : String(err)
  return context ? `${context}: ${m}` : m
}

export function showError(err: unknown, context = ''): void {
  const msg = describe(err, context)
  if (err instanceof ApiError && err.status === 401) {
    void vscode.window.showErrorMessage(msg, 'Sign in').then((c) => { if (c === 'Sign in') void vscode.commands.executeCommand('dithub.signIn') })
    return
  }
  void vscode.window.showErrorMessage(msg)
}

export function nonce(): string {
  const a = new Uint8Array(18)
  crypto.getRandomValues(a)
  return Buffer.from(a).toString('base64').replace(/[^A-Za-z0-9]/g, '')
}
