'use client'

import { useEffect, useState } from 'react'
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

export default function ResellTracker() {
  // State
  const [sales, setSales] = useState<Sale[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'sales' | 'inventory' | 'expenses'>('sales')

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

    // If eBay with actual received amount, calculate differently
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

  // Stats calculations
  const totalSales = sales.reduce((sum, sale) => sum + sale.sale_price, 0)
  const totalFees = sales.reduce((sum, sale) => sum + sale.platform_fee, 0)
  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0)
  const inventoryValue = inventory.reduce((sum, item) => sum + item.item_cost, 0)
  const netProfit = sales.reduce((sum, sale) => sum + sale.profit, 0) - totalExpenses

  // Sort functions
  const sortedSales = [...sales].sort((a, b) => a.item_name.localeCompare(b.item_name))
  const sortedInventory = [...inventory].sort((a, b) => a.item_name.localeCompare(b.item_name))

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Resale Tracker 2026</h1>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="text-sm text-gray-600">Total Sales</div>
            <div className="text-2xl font-bold text-green-600">${totalSales.toFixed(2)}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="text-sm text-gray-600">Total Fees</div>
            <div className="text-2xl font-bold text-red-600">${totalFees.toFixed(2)}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="text-sm text-gray-600">Bulk Expenses</div>
            <div className="text-2xl font-bold text-orange-600">${totalExpenses.toFixed(2)}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="text-sm text-gray-600">Inventory Value</div>
            <div className="text-2xl font-bold text-blue-600">${inventoryValue.toFixed(2)}</div>
          </div>
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="text-sm text-gray-600">Net Profit</div>
            <div className="text-2xl font-bold text-purple-600">${netProfit.toFixed(2)}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveTab('sales')}
            className={`px-6 py-3 rounded-lg font-semibold ${
              activeTab === 'sales' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'
            }`}
          >
            Sales
          </button>
          <button
            onClick={() => setActiveTab('inventory')}
            className={`px-6 py-3 rounded-lg font-semibold ${
              activeTab === 'inventory' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'
            }`}
          >
            Inventory
          </button>
          <button
            onClick={() => setActiveTab('expenses')}
            className={`px-6 py-3 rounded-lg font-semibold ${
              activeTab === 'expenses' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'
            }`}
          >
            Bulk Expenses
          </button>
        </div>

        {/* Sales Tab */}
        {activeTab === 'sales' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Add Sale</h2>
              <form onSubmit={handleAddSale} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                    <input
                      type="text"
                      required
                      value={saleForm.item_name}
                      onChange={(e) => setSaleForm({...saleForm, item_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                    <select
                      value={saleForm.platform}
                      onChange={(e) => setSaleForm({...saleForm, platform: e.target.value as any})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    >
                      <option value="eBay">eBay</option>
                      <option value="Mercari">Mercari</option>
                      <option value="Poshmark">Poshmark</option>
                      <option value="Depop">Depop</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sale Date</label>
                    <input
                      type="date"
                      required
                      value={saleForm.sale_date}
                      onChange={(e) => setSaleForm({...saleForm, sale_date: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sale Price</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={saleForm.sale_price}
                      onChange={(e) => setSaleForm({...saleForm, sale_price: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Item Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      value={saleForm.item_cost}
                      onChange={(e) => setSaleForm({...saleForm, item_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Shipping Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      value={saleForm.shipping_cost}
                      onChange={(e) => setSaleForm({...saleForm, shipping_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="0.00"
                    />
                  </div>
                </div>

                {saleForm.platform === 'eBay' && (
                  <div className="border-t pt-4 mt-4">
                    <h3 className="font-semibold mb-2 text-gray-700">eBay Special Fields (Optional)</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Gross Total (w/ tax)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={saleForm.gross_total}
                          onChange={(e) => setSaleForm({...saleForm, gross_total: e.target.value})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">What I Actually Received</label>
                        <input
                          type="number"
                          step="0.01"
                          value={saleForm.actual_received}
                          onChange={(e) => setSaleForm({...saleForm, actual_received: e.target.value})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700"
                >
                  Add Sale
                </button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Sales History ({sales.length})</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2">Item</th>
                      <th className="text-left py-2">Platform</th>
                      <th className="text-left py-2">Date</th>
                      <th className="text-right py-2">Sale Price</th>
                      <th className="text-right py-2">Fee</th>
                      <th className="text-right py-2">Cost</th>
                      <th className="text-right py-2">Profit</th>
                      <th className="text-right py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSales.map((sale) => (
                      <tr key={sale.id} className="border-b hover:bg-gray-50">
                        <td className="py-2">{sale.item_name}</td>
                        <td className="py-2">{sale.platform}</td>
                        <td className="py-2">{new Date(sale.sale_date).toLocaleDateString()}</td>
                        <td className="text-right py-2">${sale.sale_price.toFixed(2)}</td>
                        <td className="text-right py-2">${sale.platform_fee.toFixed(2)}</td>
                        <td className="text-right py-2">${sale.item_cost.toFixed(2)}</td>
                        <td className="text-right py-2 font-semibold">${sale.profit.toFixed(2)}</td>
                        <td className="text-right py-2">
                          <button
                            onClick={() => handleDeleteSale(sale.id)}
                            className="text-red-600 hover:text-red-800"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Inventory Tab */}
        {activeTab === 'inventory' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Add Inventory</h2>
              <form onSubmit={handleAddInventory} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                    <input
                      type="text"
                      required
                      value={inventoryForm.item_name}
                      onChange={(e) => setInventoryForm({...inventoryForm, item_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Item Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={inventoryForm.item_cost}
                      onChange={(e) => setInventoryForm({...inventoryForm, item_cost: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="0.00 for personal items"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Platforms (Crosslisting)</label>
                  <div className="flex gap-4">
                    {['eBay', 'Mercari', 'Poshmark', 'Depop'].map((platform) => (
                      <label key={platform} className="flex items-center">
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
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700"
                >
                  Add to Inventory
                </button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Current Inventory ({inventory.length})</h2>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Sale Date for Mark as Sold</label>
                <input
                  type="date"
                  value={markSoldDate}
                  onChange={(e) => setMarkSoldDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div className="space-y-2">
                {sortedInventory.map((item) => (
                  <div key={item.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                    <div>
                      <div className="font-semibold">{item.item_name}</div>
                      <div className="text-sm text-gray-600">
                        Cost: ${item.item_cost.toFixed(2)} |
                        Platforms: {item.platforms.length > 0 ? item.platforms.join(', ') : 'None selected'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => markAsSold(item)}
                        className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                      >
                        Mark as Sold
                      </button>
                      <button
                        onClick={() => handleDeleteInventory(item.id)}
                        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Expenses Tab */}
        {activeTab === 'expenses' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Add Bulk Expense</h2>
              <form onSubmit={handleAddExpense} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Expense Name</label>
                    <input
                      type="text"
                      required
                      value={expenseForm.name}
                      onChange={(e) => setExpenseForm({...expenseForm, name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder="e.g., Tape, Mailers, etc."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={expenseForm.amount}
                      onChange={(e) => setExpenseForm({...expenseForm, amount: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                    <input
                      type="date"
                      required
                      value={expenseForm.date_added}
                      onChange={(e) => setExpenseForm({...expenseForm, date_added: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-orange-600 text-white py-3 rounded-lg font-semibold hover:bg-orange-700"
                >
                  Add Expense
                </button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-2xl font-bold mb-4">Expenses History ({expenses.length})</h2>
              <div className="space-y-2">
                {expenses.map((expense) => (
                  <div key={expense.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                    <div>
                      <div className="font-semibold">{expense.name}</div>
                      <div className="text-sm text-gray-600">
                        {new Date(expense.date_added).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-lg font-bold">${expense.amount.toFixed(2)}</div>
                      <button
                        onClick={() => handleDeleteExpense(expense.id)}
                        className="text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
