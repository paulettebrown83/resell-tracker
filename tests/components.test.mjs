import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' })
globalThis.window = dom.window
globalThis.self = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const require = createRequire(import.meta.url)
let authListener
let unsubscribed = false
const checks = []
const client = {
  supabase: { auth: {
    onAuthStateChange(callback) {
      authListener = callback
      return { data: { subscription: { unsubscribe() { unsubscribed = true } } } }
    }
  } },
  signInWithGoogle: async () => {},
  requireAccess() {
    const check = Promise.withResolvers()
    checks.push(check)
    return check.promise
  },
  saveSale() { throw new Error('This test must not save records') }
}
// Compile and render the real TSX components. Only the network/auth boundary is replaced.
function loadComponent(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } })
  const compiledModule = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    name => name === '@/lib/supabase' ? client : require(name), compiledModule, compiledModule.exports
  )
  return compiledModule.exports.default
}
const AuthGate = loadComponent('../components/AuthGate.tsx')
const SaleEditor = loadComponent('../components/SaleEditor.tsx')
const root = createRoot(document.getElementById('root'))
const account = id => ({ user: { id, email: `${id}@example.invalid` }, access_token: `synthetic-${id}` })
const owner = account('owner')
const other = account('other')
const emit = async (event, session) => act(async () => { authListener(event, session) })
const settle = async (check, allowed = true) => act(async () => {
  if (allowed) check.resolve()
  else check.reject(new Error('Access denied'))
  await check.promise.catch(() => {})
})
function DraftForm() {
  const [draft, setDraft] = useState('')
  return React.createElement('input', {
    'aria-label': 'Unsaved sale', value: draft, onChange: event => setDraft(event.target.value)
  })
}
const draftInput = () => document.querySelector('[aria-label="Unsaved sale"]')
async function enterDraft(value) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(draftInput(), value)
    draftInput().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

try {
  await act(() => root.render(React.createElement(AuthGate, null, React.createElement(DraftForm))))
  await emit('INITIAL_SESSION', owner)
  assert.equal(draftInput(), null, 'Initial account is hidden until permission succeeds')
  await settle(checks.at(-1))
  await enterDraft('Vintage jacket, $47, shipping still being entered')
  const originalInput = draftInput()
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED']) {
    const previousCheckCount = checks.length
    // Reuse the same session object to ensure every event causes revalidation.
    await emit(event, owner)
    assert.equal(draftInput(), originalInput, `${event} must not unmount a permitted account's form`)
    assert.equal(checks.length, previousCheckCount + 1)
    assert.equal(draftInput().value, 'Vintage jacket, $47, shipping still being entered')
    await settle(checks.at(-1))
    assert.equal(draftInput(), originalInput)
  }
  console.log('PASS actual AuthGate preserves entered form state during and after same-user sign-in/token refresh')

  await emit('TOKEN_REFRESHED', owner)
  const staleOwnerSuccess = checks.at(-1)
  await emit('SIGNED_IN', other)
  const otherAccess = checks.at(-1)
  assert.equal(draftInput(), null, 'Switching users immediately hides the old form')
  await settle(staleOwnerSuccess)
  assert.equal(draftInput(), null, 'An old account response cannot authorize the new account')
  await settle(otherAccess)
  assert.notEqual(draftInput(), originalInput)
  assert.equal(draftInput().value, '', 'The new account cannot inherit unsaved data')
  console.log('PASS account switch clears the prior form and ignores stale authorization success')

  await emit('TOKEN_REFRESHED', other)
  const staleDenial = checks.at(-1)
  await emit('SIGNED_IN', other)
  await settle(checks.at(-1))
  await settle(staleDenial, false)
  assert.ok(draftInput(), 'An obsolete failed check cannot revoke a newer successful check')
  await emit('TOKEN_REFRESHED', other)
  await settle(checks.at(-1), false)
  assert.equal(draftInput(), null, 'Failed current permission check removes access')
  assert.match(document.querySelector('[role="alert"]').textContent, /access is unavailable/)
  console.log('PASS current access denial removes the app; stale denial does not override newer success')

  await emit('SIGNED_IN', owner)
  await settle(checks.at(-1))
  await enterDraft('Another unsaved sale')
  await emit('TOKEN_REFRESHED', owner)
  const pendingBeforeSignOut = checks.at(-1)
  await emit('SIGNED_OUT', null)
  assert.equal(draftInput(), null, 'Sign-out immediately hides the current form')
  await settle(pendingBeforeSignOut)
  assert.equal(draftInput(), null, 'Pending validation cannot restore a signed-out account')
  assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Continue with Google'))
  assert.equal(document.querySelector('input[type="password"]'), null)
  console.log('PASS sign-out remains denied when an older permission response arrives')

  await emit('SIGNED_IN', owner)
  await settle(checks.at(-1))
  await act(() => root.render(React.createElement(AuthGate, {area:'genealogy'}, React.createElement(DraftForm))))
  assert.equal(draftInput(), null, 'Resale permission cannot briefly authorize genealogy')
  await settle(checks.at(-1), false)
  assert.equal(draftInput(), null)
  console.log('PASS changing app area requires its own successful permission check')

  for (const shipping of [null, 0, 4.5]) {
    await act(() => root.render(React.createElement(SaleEditor, {
      key: String(shipping), item: null,
      sale: { id: 'legacy-sale', item_name: 'Vintage jacket', platform: 'Vinted',
        sale_date: '2026-09-01', sale_price: 47, platform_fee: 2, item_cost: 5,
        shipping_cost: shipping, version: 1 },
      onSaved: async () => {}, onCancel: () => {}
    })))
    const label = [...document.querySelectorAll('label')].find(node => node.textContent.startsWith('Shipping paid separately'))
    const input = label.querySelector('input')
    assert.equal(input.required, true)
    assert.equal(input.value, shipping == null ? '' : String(shipping))
    assert.equal(input.validity.valueMissing, shipping == null)
  }
  console.log('PASS actual SaleEditor requires unknown legacy shipping while preserving known zero/positive amounts')
  assert.equal(unsubscribed, true, 'Auth listener is removed when AuthGate unmounts')
} finally {
  await act(() => root.unmount())
  dom.window.close()
}
