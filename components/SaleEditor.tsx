'use client'
import { useRef, useState } from 'react'
import { saveSale, type InventoryItem, type Sale } from '@/lib/supabase'

export default function SaleEditor({ item, sale, onSaved, onCancel }: {
  item: InventoryItem | null; sale: Sale | null; onSaved: () => Promise<void>; onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    item_name: sale?.item_name || item?.item_name || '', platform: sale?.platform || 'Vinted',
    sale_date: sale?.sale_date || new Date().toLocaleDateString('en-CA'),
    sale_price: sale ? String(sale.sale_price) : '', platform_fee: sale ? String(sale.platform_fee) : '',
    item_cost: sale ? (sale.item_cost == null ? '' : String(sale.item_cost)) : String(item?.item_cost ?? 0), shipping_cost: sale ? String(sale.shipping_cost ?? 0) : '',
    actual_received: sale?.actual_received == null ? '' : String(sale.actual_received),
    gross_total: sale?.gross_total == null ? '' : String(sale.gross_total),
    source_system: sale?.source_system || '', source_record_id: sale?.source_record_id || '', reason: ''
  })
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      await saveSale({
        ...(sale ? { id: sale.id, version: sale.version, reason: form.reason } : {}),
        ...(item ? { inventory_id: item.id } : {}),
        item_name: form.item_name, platform: form.platform, sale_date: form.sale_date,
        sale_price: Number(form.sale_price), platform_fee: Number(form.platform_fee),
        item_cost: Number(form.item_cost), shipping_cost: Number(form.shipping_cost),
        ...(form.actual_received !== '' ? { actual_received: Number(form.actual_received) } : {}),
        ...(form.gross_total !== '' ? { gross_total: Number(form.gross_total) } : {}),
        ...(form.source_system ? { source_system: form.source_system, source_record_id: form.source_record_id } : {})
      })
      await onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Save was not confirmed. Use Retry pending save to check it before adding another sale.') }
    finally { lock.current = false; setBusy(false) }
  }
  const fields: { key: keyof typeof form; label: string; type: string; optional?: boolean }[] = [
    { key: 'item_name', label: 'Item name', type: 'text' },
    { key: 'platform', label: 'Marketplace', type: 'text' },
    { key: 'sale_date', label: 'Sale date', type: 'date' },
    { key: 'sale_price', label: 'Sale price', type: 'number' },
    { key: 'platform_fee', label: 'Actual platform fee (enter 0 if none)', type: 'number' },
    { key: 'item_cost', label: 'Item cost', type: 'number' },
    { key: 'shipping_cost', label: 'Shipping paid separately (enter 0 if none)', type: 'number' },
    { key: 'actual_received', label: 'Net payout after marketplace deductions (optional)', type: 'number', optional: true },
    { key: 'gross_total', label: 'Gross total from statement (optional)', type: 'number', optional: true }
  ]
  return <section>
    <h2 className="text-xl font-bold mb-2">{sale ? 'Correct sale' : item ? 'Record sale for inventory item' : 'Add sale'}</h2>
    <p className="text-sm text-gray-600 mb-4">Use the marketplace statement. Fees are actual amounts. If you enter a net payout, profit uses that payout minus item cost and shipping paid separately. Do not count shipping already deducted from the payout again.</p>
    {(item || sale?.inventory_id) && <p className="text-xs mb-3 break-all">Item ID: {item?.id || sale?.inventory_id}</p>}
    {error && <p role="alert" className="text-red-700 mb-3">{error}</p>}
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {fields.map(({ key, label, type, optional }) => <label key={key} className="block text-xs text-gray-700">{label}
          {key === 'platform' ? <select className="block border rounded w-full p-2 text-sm" value={form.platform} onChange={e => setForm({ ...form, platform: e.target.value })}>
            {['Vinted', 'Depop', 'Poshmark', 'Mercari', 'eBay'].map(platform => <option key={platform}>{platform}</option>)}
          </select> : <input className="block border rounded w-full p-2 text-sm" type={type} min={type === 'number' ? '0' : undefined} step={type === 'number' ? '0.01' : undefined}
            required={!optional} readOnly={!!item && (key === 'item_name' || key === 'item_cost')}
            value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />}
        </label>)}
        {!sale && <>
          <label className="text-xs">Source and account (optional)<input className="block border rounded w-full p-2" placeholder="vinted:my-account" value={form.source_system} onChange={e => setForm({ ...form, source_system: e.target.value })} /></label>
          <label className="text-xs">Source record ID (order + line for bundles)<input className="block border rounded w-full p-2" required={!!form.source_system} disabled={!form.source_system} value={form.source_record_id} onChange={e => setForm({ ...form, source_record_id: e.target.value })} /></label>
        </>}
        {sale && <label className="text-xs md:col-span-2">Reason for correction<input required className="block border rounded w-full p-2" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></label>}
      </fieldset>
      <button disabled={busy} className="bg-indigo-600 text-white rounded px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : sale ? 'Save correction' : 'Record sale'}</button>
      <button disabled={busy} type="button" className="ml-3 underline" onClick={onCancel}>Clear form</button>
    </form>
  </section>
}
