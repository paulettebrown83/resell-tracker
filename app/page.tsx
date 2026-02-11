'use client'

import { useEffect, useState, useMemo } from 'react'
import {
  getSales,
  getInventory,
  getExpenses,
  addSale,
  addInventoryItem,
  addExpense,
  deleteSale,
  deleteInventoryItem,
  deleteExpense,
  type Sale,
  type InventoryItem,
  type Expense
} from '@/lib/supabase'

const PLATFORM_COLORS: Record<string, string> = {
  eBay: '#e53238',
  Mercari: '#ff6f61',
  Poshmark: '#630d1e',
  Depop: '#ff0000'
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
  ].join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function ResellTracker() {
  // Data state
  const [sales, setSales] = useState<Sale[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'sales' | 'inventory' | 'expenses'>('sales')

  // Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [dateRange, setDateRange] = useState({ start: '', end: '' })
  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString())

  // Form states
  const [saleForm, setSaleForm] = useState({
    item_name: '',
    platform: 'eBay' as 'eBay' | 'Mercari' | 'Poshmark' | 'Depop',
    sale_date: new Date().toISOString().split('T')[0],
    sale_price: '',
    item_cost: '',
    shipping_cost: '',
    gross_total: '',
    actual_received: ''
  })

  const [inventoryForm, setInventoryForm] = useState({
    item_name: '',
    item_cost: '',
    platforms: [] as string[]
  })

  const [expenseForm, setExpenseForm] = useState({
    name: '',
    amount: '',
    date_added: new Date().toISOString().split('T')[0]
  })

  const [markSoldDate, setMarkSoldDate] = useState(new Date().toISOString().split('T')[0])

  // Load data
  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      setLoading(true)
      const [salesData, inventoryData, expensesData] = await Promise.all([
        getSales(),
        getInventory(),
        getExpenses()
      ])
      setSales(salesData)
      setInventory(inventoryData)
      setExpenses(expensesData)
    } catch (error) {
      console.error('Error loading data:', error)
      alert('Error loading data. Check console for details.')
    } finally {
      setLoading(false)
    }
  }

  // Available years (derived from data)
  const availableYears = useMemo(() => {
    const years = new Set<string>()
    sales.forEach(s => years.add(s.sale_date.substring(0, 4)))
    expenses.forEach(e => years.add(e.date_added.substring(0, 4)))
    inventory.forEach(i => {
      if (i.date_added) years.add(i.date_added.substring(0, 4))
    })
    const sorted = Array.from(years).sort((a, b) => b.localeCompare(a))
    if (sorted.length === 0) sorted.push(new Date().getFullYear().toString())
    return sorted
  }, [sales, expenses, inventory])

  // Filtered data
  const filteredSales = useMemo(() => {
    return sales.filter(sale => {
      if (selectedYear !== 'all' && !sale.sale_date.startsWith(selectedYear)) return false
      if (searchQuery && !sale.item_name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (platformFilter !== 'all' && sale.platform !== platformFilter) return false
      if (dateRange.start && sale.sale_date < dateRange.start) return false
      if (dateRange.end && sale.sale_date > dateRange.end) return false
      return true
    }).sort((a, b) => a.item_name.localeCompare(b.item_name))
  }, [sales, selectedYear, searchQuery, platformFilter, dateRange])

  const filteredInventory = useMemo(() => {
    return inventory.filter(item => {
      // Inventory is always current stock — no year filter
      if (searchQuery && !item.item_name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (platformFilter !== 'all' && !item.platforms.includes(platformFilter)) return false
      if (dateRange.start && item.date_added && item.date_added < dateRange.start) return false
      if (dateRange.end && item.date_added && item.date_added > dateRange.end) return false
      return true
    }).sort((a, b) => a.item_name.localeCompare(b.item_name))
  }, [inventory, searchQuery, platformFilter, dateRange])

  const filteredExpenses = useMemo(() => {
    return expenses.filter(exp => {
      if (selectedYear !== 'all' && !exp.date_added.startsWith(selectedYear)) return false
      if (searchQuery && !exp.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (dateRange.start && exp.date_added < dateRange.start) return false
      if (dateRange.end && exp.date_added > dateRange.end) return false
      return true
    })
  }, [expenses, selectedYear, searchQuery, dateRange])

  // Stats from filtered data
  const totalSales = filteredSales.reduce((sum, sale) => sum + sale.sale_price, 0)
  const totalFees = filteredSales.reduce((sum, sale) => sum + sale.platform_fee, 0)
  const totalExpenses = filteredExpenses.reduce((sum, exp) => sum + exp.amount, 0)
  const inventoryValue = inventory.reduce((sum, item) => sum + item.item_cost, 0)
  const netProfit = filteredSales.reduce((sum, sale) => sum + sale.profit, 0) - totalExpenses

  // Fee calculations
  function calculateFees(platform: string, salePrice: number) {
    switch (platform) {
      case 'eBay':
        return salePrice * 0.136 + 0.40
      case 'Mercari':
        return salePrice * 0.129 + 0.30
      case 'Poshmark':
        return salePrice < 15 ? 2.95 : salePrice * 0.20
      case 'Depop':
        return salePrice * 0.033 + 0.45
      default:
        return 0
    }
  }

  // Handle add sale
  async function handleAddSale(e: React.FormEvent) {
    e.preventDefault()

    const salePrice = parseFloat(saleForm.sale_price)
    const itemCost = parseFloat(saleForm.item_cost) || 0
    const shippingCost = parseFloat(saleForm.shipping_cost) || 0

    let platformFee: number
    let profit: number

    if (saleForm.platform === 'eBay' && saleForm.actual_received) {
      const actualReceived = parseFloat(saleForm.actual_received)
      const grossTotal = parseFloat(saleForm.gross_total) || salePrice
      platformFee = grossTotal - actualReceived
      profit = actualReceived - itemCost - shippingCost
    } else {
      platformFee = calculateFees(saleForm.platform, salePrice)
      profit = salePrice - platformFee - itemCost - shippingCost
    }

    try {
      await addSale({
        item_name: saleForm.item_name,
        platform: saleForm.platform,
        sale_date: saleForm.sale_date,
        sale_price: salePrice,
        platform_fee: platformFee,
        item_cost: itemCost,
        shipping_cost: shippingCost,
        profit: profit,
        gross_total: saleForm.gross_total ? parseFloat(saleForm.gross_total) : undefined,
        actual_received: saleForm.actual_received ? parseFloat(saleForm.actual_received) : undefined
      })

      await loadData()
      setSaleForm({
        item_name: '',
        platform: 'eBay',
        sale_date: new Date().toISOString().split('T')[0],
        sale_price: '',
        item_cost: '',
        shipping_cost: '',
        gross_total: '',
        actual_received: ''
      })
    } catch (error) {
      console.error('Error adding sale:', error)
      alert('Error adding sale. Check console for details.')
    }
  }

  // Handle add inventory
  async function handleAddInventory(e: React.FormEvent) {
    e.preventDefault()

    try {
      await addInventoryItem({
        item_name: inventoryForm.item_name,
        item_cost: parseFloat(inventoryForm.item_cost) || 0,
        platforms: inventoryForm.platforms,
        date_added: new Date().toISOString().split('T')[0]
      })

      await loadData()
      setInventoryForm({
        item_name: '',
        item_cost: '',
        platforms: []
      })
    } catch (error) {
      console.error('Error adding inventory:', error)
      alert('Error adding inventory. Check console for details.')
    }
  }

  // Handle add expense
  async function handleAddExpense(e: React.FormEvent) {
    e.preventDefault()

    try {
      await addExpense({
        name: expenseForm.name,
        amount: parseFloat(expenseForm.amount),
        date_added: expenseForm.date_added
      })

      await loadData()
      setExpenseForm({
        name: '',
        amount: '',
        date_added: new Date().toISOString().split('T')[0]
      })
    } catch (error) {
      console.error('Error adding expense:', error)
      alert('Error adding expense. Check console for details.')
    }
  }

  // Mark inventory as sold
  async function markAsSold(item: InventoryItem) {
    const salePrice = prompt(`Enter sale price for ${item.item_name}:`)
    if (!salePrice) return

    const platform = prompt('Platform (eBay/Mercari/Poshmark/Depop):') as 'eBay' | 'Mercari' | 'Poshmark' | 'Depop'
    if (!platform) return

    const price = parseFloat(salePrice)
    const platformFee = calculateFees(platform, price)
    const profit = price - platformFee - item.item_cost

    try {
      await addSale({
        item_name: item.item_name,
        platform: platform,
        sale_date: markSoldDate,
        sale_price: price,
        platform_fee: platformFee,
        item_cost: item.item_cost,
        shipping_cost: 0,
        profit: profit
      })

      await deleteInventoryItem(item.id)
      await loadData()
    } catch (error) {
      console.error('Error marking as sold:', error)
      alert('Error marking as sold. Check console for details.')
    }
  }

  // Delete handlers
  async function handleDeleteSale(id: string) {
    if (!confirm('Delete this sale?')) return
    try {
      await deleteSale(id)
      await loadData()
    } catch (error) {
      console.error('Error deleting sale:', error)
    }
  }

  async function handleDeleteInventory(id: string) {
    if (!confirm('Delete this inventory item?')) return
    try {
      await deleteInventoryItem(id)
      await loadData()
    } catch (error) {
      console.error('Error deleting inventory:', error)
    }
  }

  async function handleDeleteExpense(id: string) {
    if (!confirm('Delete this expense?')) return
    try {
      await deleteExpense(id)
      await loadData()
    } catch (error) {
      console.error('Error deleting expense:', error)
    }
  }

  // CSV exports
  function exportSalesCSV() {
    const headers = ['Item', 'Platform', 'Date', 'Sale Price', 'Fee', 'Cost', 'Shipping', 'Profit']
    const rows = filteredSales.map(s => [
      s.item_name, s.platform, s.sale_date,
      s.sale_price.toFixed(2), s.platform_fee.toFixed(2),
      s.item_cost.toFixed(2), s.shipping_cost.toFixed(2), s.profit.toFixed(2)
    ])
    downloadCSV(`sales-${selectedYear}.csv`, headers, rows)
  }

  function exportInventoryCSV() {
    const headers = ['Item', 'Cost', 'Platforms', 'Date Added']
    const rows = filteredInventory.map(i => [
      i.item_name, i.item_cost.toFixed(2),
      i.platforms.join('; '), i.date_added || ''
    ])
    downloadCSV('inventory.csv', headers, rows)
  }

  function exportExpensesCSV() {
    const headers = ['Name', 'Amount', 'Date']
    const rows = filteredExpenses.map(e => [
      e.name, e.amount.toFixed(2), e.date_added
    ])
    downloadCSV(`expenses-${selectedYear}.csv`, headers, rows)
  }

  function clearFilters() {
    setSearchQuery('')
    setPlatformFilter('all')
    setDateRange({ start: '', end: '' })
  }

  const hasActiveFilters = searchQuery || platformFilter !== 'all' || dateRange.start || dateRange.end

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-white text-xl font-semibold">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4 md:p-5">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-3 mb-1">
            <h1 className="text-2xl md:text-3xl font-bold text-white">Resale Tracker</h1>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="px-3 py-1 rounded-lg text-sm font-semibold bg-white/20 text-white border border-white/30 backdrop-blur-sm"
            >
              <option value="all" className="text-gray-900">All Years</option>
              {availableYears.map(y => (
                <option key={y} value={y} className="text-gray-900">{y}</option>
              ))}
            </select>
          </div>
          <p className="text-white/80 text-sm">Track your reselling profits across platforms</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div className="bg-white p-4 rounded-lg shadow-md">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Total Sales</div>
            <div className="text-xl font-bold text-green-600">${totalSales.toFixed(2)}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-md">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Total Fees</div>
            <div className="text-xl font-bold text-red-600">${totalFees.toFixed(2)}</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-md">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Bulk Expenses</div>
            <div className="text-xl font-bold text-orange-600">${totalExpenses.toFixed(2)}</div>
          </div>
          <div className="bg-amber-50 p-4 rounded-lg shadow-md border-2 border-amber-500">
            <div className="text-[10px] uppercase tracking-wider text-amber-700 font-semibold">Inventory Value</div>
            <div className="text-xl font-bold text-amber-600">${inventoryValue.toFixed(2)}</div>
          </div>
          <div className="col-span-2 md:col-span-1 bg-white p-4 rounded-lg shadow-md">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Net Profit</div>
            <div className={`text-xl font-bold ${netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {netProfit >= 0 ? '+' : ''}{netProfit.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          {(['sales', 'inventory', 'expenses'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); clearFilters() }}
              className={`text-sm px-3 py-2 md:text-base md:px-6 md:py-3 rounded-lg font-semibold transition-colors ${
                activeTab === tab
                  ? 'bg-indigo-500 text-white shadow-md'
                  : 'bg-white/90 text-gray-700 hover:bg-white'
              }`}
            >
              {tab === 'expenses' ? 'Bulk Expenses' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Sales Tab */}
        {activeTab === 'sales' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left column: Form */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <h2 className="text-xl font-bold mb-1">Add Sale</h2>
              <div className="border-l-4 border-blue-400 bg-blue-50 p-3 rounded-r mb-4 text-sm text-blue-800">
                Log a completed sale. Fees are calculated automatically per platform.
              </div>
              <form onSubmit={handleAddSale} className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
                    <input
                      type="text"
                      required
                      value={saleForm.item_name}
                      onChange={(e) => setSaleForm({...saleForm, item_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Platform</label>
                    <select
                      value={saleForm.platform}
                      onChange={(e) => setSaleForm({...saleForm, platform: e.target.value as 'eBay' | 'Mercari' | 'Poshmark' | 'Depop'})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    >
                      <option value="eBay">eBay</option>
                      <option value="Mercari">Mercari</option>
                      <option value="Poshmark">Poshmark</option>
                      <option value="Depop">Depop</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Sale Date</label>
                    <input
                      type="date"
                      required
                      value={saleForm.sale_date}
                      onChange={(e) => setSaleForm({...saleForm, sale_date: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Sale Price</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={saleForm.sale_price}
                      onChange={(e) => setSaleForm({...saleForm, sale_price: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      value={saleForm.item_cost}
                      onChange={(e) => setSaleForm({...saleForm, item_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Shipping Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      value={saleForm.shipping_cost}
                      onChange={(e) => setSaleForm({...saleForm, shipping_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="0.00"
                    />
                  </div>
                </div>

                {saleForm.platform === 'eBay' && (
                  <div className="border-t pt-3 mt-3">
                    <h3 className="font-semibold mb-2 text-gray-700 text-sm">eBay Special Fields (Optional)</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Gross Total (w/ tax)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={saleForm.gross_total}
                          onChange={(e) => setSaleForm({...saleForm, gross_total: e.target.value})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">What I Actually Received</label>
                        <input
                          type="number"
                          step="0.01"
                          value={saleForm.actual_received}
                          onChange={(e) => setSaleForm({...saleForm, actual_received: e.target.value})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-indigo-500 text-white py-2.5 rounded-lg font-semibold hover:bg-indigo-600 transition-colors"
                >
                  Add Sale
                </button>
              </form>
            </div>

            {/* Right column: Sales list */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-bold">Sales ({filteredSales.length})</h2>
                <button
                  onClick={exportSalesCSV}
                  className="px-3 py-1.5 bg-emerald-500 text-white text-sm rounded-lg font-semibold hover:bg-emerald-600 transition-colors"
                >
                  Export CSV
                </button>
              </div>

              {/* Filter bar */}
              <div className="space-y-2 mb-3">
                <input
                  type="text"
                  placeholder="Search items..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <div className="flex gap-2 flex-wrap">
                  <select
                    value={platformFilter}
                    onChange={(e) => setPlatformFilter(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="all">All Platforms</option>
                    <option value="eBay">eBay</option>
                    <option value="Mercari">Mercari</option>
                    <option value="Poshmark">Poshmark</option>
                    <option value="Depop">Depop</option>
                  </select>
                  <input
                    type="date"
                    value={dateRange.start}
                    onChange={(e) => setDateRange({...dateRange, start: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    placeholder="From"
                  />
                  <input
                    type="date"
                    value={dateRange.end}
                    onChange={(e) => setDateRange({...dateRange, end: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                    placeholder="To"
                  />
                  {hasActiveFilters && (
                    <button
                      onClick={clearFilters}
                      className="px-3 py-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Sales cards */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {filteredSales.map((sale) => (
                  <div
                    key={sale.id}
                    className="p-3 border rounded-lg border-l-4 hover:shadow-sm transition-shadow"
                    style={{ borderLeftColor: PLATFORM_COLORS[sale.platform] || '#6366f1' }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm truncate">{sale.item_name}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <span
                            className="px-2 py-0.5 rounded-full text-white text-xs font-medium"
                            style={{ backgroundColor: PLATFORM_COLORS[sale.platform] }}
                          >
                            {sale.platform}
                          </span>
                          <span className="text-xs text-gray-500">
                            {new Date(sale.sale_date).toLocaleDateString()}
                          </span>
                          <span className="text-xs text-gray-500">
                            ${sale.sale_price.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`font-bold text-sm ${sale.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {sale.profit >= 0 ? '+' : ''}${sale.profit.toFixed(2)}
                        </span>
                        <button
                          onClick={() => handleDeleteSale(sale.id)}
                          className="text-red-400 hover:text-red-600 text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {filteredSales.length === 0 && (
                  <div className="text-center text-gray-400 py-8 text-sm">No sales found</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Inventory Tab */}
        {activeTab === 'inventory' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left column: Form */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <h2 className="text-xl font-bold mb-1">Add Inventory</h2>
              <div className="border-l-4 border-blue-400 bg-blue-50 p-3 rounded-r mb-4 text-sm text-blue-800">
                Add items you&apos;ve sourced. Use $0 cost for personal/vintage items.
              </div>
              <form onSubmit={handleAddInventory} className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
                    <input
                      type="text"
                      required
                      value={inventoryForm.item_name}
                      onChange={(e) => setInventoryForm({...inventoryForm, item_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Item Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={inventoryForm.item_cost}
                      onChange={(e) => setInventoryForm({...inventoryForm, item_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="0.00 for personal items"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Platforms (Crosslisting)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['eBay', 'Mercari', 'Poshmark', 'Depop'] as const).map((platform) => (
                      <label key={platform} className="flex items-center text-sm">
                        <input
                          type="checkbox"
                          checked={inventoryForm.platforms.includes(platform)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setInventoryForm({
                                ...inventoryForm,
                                platforms: [...inventoryForm.platforms, platform]
                              })
                            } else {
                              setInventoryForm({
                                ...inventoryForm,
                                platforms: inventoryForm.platforms.filter(p => p !== platform)
                              })
                            }
                          }}
                          className="mr-2"
                        />
                        {platform}
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-amber-500 text-white py-2.5 rounded-lg font-semibold hover:bg-amber-600 transition-colors"
                >
                  Add to Inventory
                </button>
              </form>
            </div>

            {/* Right column: Inventory list */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-bold">Inventory ({filteredInventory.length})</h2>
                <button
                  onClick={exportInventoryCSV}
                  className="px-3 py-1.5 bg-emerald-500 text-white text-sm rounded-lg font-semibold hover:bg-emerald-600 transition-colors"
                >
                  Export CSV
                </button>
              </div>

              {/* Filter bar */}
              <div className="space-y-2 mb-3">
                <input
                  type="text"
                  placeholder="Search items..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <div className="flex gap-2 flex-wrap">
                  <select
                    value={platformFilter}
                    onChange={(e) => setPlatformFilter(e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="all">All Platforms</option>
                    <option value="eBay">eBay</option>
                    <option value="Mercari">Mercari</option>
                    <option value="Poshmark">Poshmark</option>
                    <option value="Depop">Depop</option>
                  </select>
                  <input
                    type="date"
                    value={dateRange.start}
                    onChange={(e) => setDateRange({...dateRange, start: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                  />
                  <input
                    type="date"
                    value={dateRange.end}
                    onChange={(e) => setDateRange({...dateRange, end: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                  />
                  {hasActiveFilters && (
                    <button
                      onClick={clearFilters}
                      className="px-3 py-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Sale Date for Mark as Sold</label>
                <input
                  type="date"
                  value={markSoldDate}
                  onChange={(e) => setMarkSoldDate(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                />
              </div>

              {/* Inventory cards */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {filteredInventory.map((item) => (
                  <div key={item.id} className="p-3 border rounded-lg hover:shadow-sm transition-shadow">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm">{item.item_name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <span className="text-xs text-gray-500">
                            Cost: ${item.item_cost.toFixed(2)}
                          </span>
                          {item.platforms.map(p => (
                            <span
                              key={p}
                              className="px-2 py-0.5 rounded-full text-white text-xs font-medium"
                              style={{ backgroundColor: PLATFORM_COLORS[p] || '#6366f1' }}
                            >
                              {p}
                            </span>
                          ))}
                          {item.platforms.length === 0 && (
                            <span className="text-xs text-gray-400">No platforms</span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => markAsSold(item)}
                          className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 transition-colors"
                        >
                          Mark Sold
                        </button>
                        <button
                          onClick={() => handleDeleteInventory(item.id)}
                          className="px-3 py-1.5 bg-red-500 text-white rounded text-xs font-medium hover:bg-red-600 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {filteredInventory.length === 0 && (
                  <div className="text-center text-gray-400 py-8 text-sm">No inventory items found</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Expenses Tab */}
        {activeTab === 'expenses' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left column: Form */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <h2 className="text-xl font-bold mb-1">Add Bulk Expense</h2>
              <div className="border-l-4 border-blue-400 bg-blue-50 p-3 rounded-r mb-4 text-sm text-blue-800">
                Track business expenses like shipping supplies, mailers, tape, etc.
              </div>
              <form onSubmit={handleAddExpense} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Expense Name</label>
                  <input
                    type="text"
                    required
                    value={expenseForm.name}
                    onChange={(e) => setExpenseForm({...expenseForm, name: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    placeholder="e.g., Tape, Mailers, etc."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={expenseForm.amount}
                      onChange={(e) => setExpenseForm({...expenseForm, amount: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                    <input
                      type="date"
                      required
                      value={expenseForm.date_added}
                      onChange={(e) => setExpenseForm({...expenseForm, date_added: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-orange-500 text-white py-2.5 rounded-lg font-semibold hover:bg-orange-600 transition-colors"
                >
                  Add Expense
                </button>
              </form>
            </div>

            {/* Right column: Expenses list */}
            <div className="bg-white p-5 rounded-lg shadow-md">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-bold">Expenses ({filteredExpenses.length})</h2>
                <button
                  onClick={exportExpensesCSV}
                  className="px-3 py-1.5 bg-emerald-500 text-white text-sm rounded-lg font-semibold hover:bg-emerald-600 transition-colors"
                >
                  Export CSV
                </button>
              </div>

              {/* Filter bar */}
              <div className="space-y-2 mb-3">
                <input
                  type="text"
                  placeholder="Search expenses..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
                <div className="flex gap-2 flex-wrap">
                  <input
                    type="date"
                    value={dateRange.start}
                    onChange={(e) => setDateRange({...dateRange, start: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                  />
                  <input
                    type="date"
                    value={dateRange.end}
                    onChange={(e) => setDateRange({...dateRange, end: e.target.value})}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                  />
                  {hasActiveFilters && (
                    <button
                      onClick={clearFilters}
                      className="px-3 py-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Expense cards */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {filteredExpenses.map((expense) => (
                  <div key={expense.id} className="flex items-center justify-between p-3 border rounded-lg hover:shadow-sm transition-shadow">
                    <div>
                      <div className="font-semibold text-sm">{expense.name}</div>
                      <div className="text-xs text-gray-500">
                        {new Date(expense.date_added).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-base font-bold text-orange-600">${expense.amount.toFixed(2)}</div>
                      <button
                        onClick={() => handleDeleteExpense(expense.id)}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {filteredExpenses.length === 0 && (
                  <div className="text-center text-gray-400 py-8 text-sm">No expenses found</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
