import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createInventoryIssue,
  createInventoryItem,
  createInventoryReceipt,
  createInventoryTransfer,
  createInventoryWarehouse,
  getInventoryBalances,
  getInventoryItems,
  getInventoryMovements,
  getInventoryWarehouses,
  type InventoryBalance,
  type InventoryItem,
  type InventoryMovement,
  type InventoryWarehouse,
} from './api';

type InventoryPageProps = {
  organizationId: string;
  page: string;
  canManage: boolean;
  canTransact: boolean;
};

type MovementKind = 'receipt' | 'issue' | 'transfer';

export default function InventoryPage({
  organizationId,
  page,
  canManage,
  canTransact,
}: InventoryPageProps) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<InventoryWarehouse[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [loadError, setLoadError] = useState<{ organizationId: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [itemSku, setItemSku] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemUnit, setItemUnit] = useState('');
  const [warehouseCode, setWarehouseCode] = useState('');
  const [warehouseName, setWarehouseName] = useState('');
  const [movementKind, setMovementKind] = useState<MovementKind>('receipt');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [currency, setCurrency] = useState('');
  const [reference, setReference] = useState('');

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    const [itemRows, warehouseRows, balanceRows, movementRows] = await Promise.all([
      getInventoryItems(organizationId),
      getInventoryWarehouses(organizationId),
      getInventoryBalances(organizationId),
      getInventoryMovements(organizationId),
    ]);
    setItems(itemRows);
    setWarehouses(warehouseRows);
    setBalances(balanceRows);
    setMovements(movementRows);
    setLoadedOrganizationId(organizationId);
    setLoadError(null);
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId) return () => { active = false; };
    Promise.all([
      getInventoryItems(organizationId),
      getInventoryWarehouses(organizationId),
      getInventoryBalances(organizationId),
      getInventoryMovements(organizationId),
    ])
      .then(([itemRows, warehouseRows, balanceRows, movementRows]) => {
        if (!active) return;
        setItems(itemRows);
        setWarehouses(warehouseRows);
        setBalances(balanceRows);
        setMovements(movementRows);
        setLoadedOrganizationId(organizationId);
        setLoadError(null);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setLoadError({
            organizationId,
            message: loadError instanceof Error ? loadError.message : 'Inventory could not be loaded.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  async function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await createInventoryItem({
        organization_id: organizationId,
        sku: itemSku,
        name: itemName,
        unit: itemUnit,
      });
      setItemSku('');
      setItemName('');
      setItemUnit('');
      setNotice('Item created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The item could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function submitWarehouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await createInventoryWarehouse({
        organization_id: organizationId,
        code: warehouseCode,
        name: warehouseName,
      });
      setWarehouseCode('');
      setWarehouseName('');
      setNotice('Warehouse created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The warehouse could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function submitMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    const selectedItemId = itemId || items[0]?.id || '';
    const selectedWarehouseId = warehouseId || warehouses[0]?.id || '';
    try {
      if (!selectedItemId || !selectedWarehouseId) {
        throw new Error('Create or select an item and warehouse before recording stock.');
      }
      const common = {
        organization_id: organizationId,
        item_id: selectedItemId,
        quantity,
        reference: reference.trim() || undefined,
      };
      if (movementKind === 'receipt') {
        if (!unitCost || !currency.trim()) {
          throw new Error('Enter the receipt unit cost and its three-letter currency code.');
        }
        await createInventoryReceipt({
          ...common,
          warehouse_id: selectedWarehouseId,
          unit_cost: unitCost,
          currency: currency.trim().toUpperCase(),
        });
        setNotice('Stock receipt recorded.');
      } else if (movementKind === 'issue') {
        await createInventoryIssue({ ...common, warehouse_id: selectedWarehouseId });
        setNotice('Stock issue recorded using FIFO cost layers.');
      } else {
        const selectedDestinationId = destinationWarehouseId || warehouses.find((row) => row.id !== selectedWarehouseId)?.id || '';
        if (!selectedDestinationId) {
          throw new Error('Select a destination warehouse different from the source.');
        }
        await createInventoryTransfer({
          ...common,
          source_warehouse_id: selectedWarehouseId,
          destination_warehouse_id: selectedDestinationId,
        });
        setNotice('Stock transfer recorded. FIFO costs were carried to the destination.');
      }
      setQuantity('');
      setUnitCost('');
      setReference('');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The inventory transaction could not be recorded.');
    } finally {
      setSaving(false);
    }
  }

  if (!organizationId) {
    return <div className="state-panel">Select an organization context to use inventory.</div>;
  }
  if (loadError?.organizationId === organizationId) {
    return (
      <div className="state-panel error-panel" role="alert">
        <span>{loadError.message}</span>
        <button className="button button-secondary" onClick={() => void refresh().catch((retryError: unknown) => setLoadError({
          organizationId,
          message: retryError instanceof Error ? retryError.message : 'Inventory could not be loaded.',
        }))}>Retry</button>
      </div>
    );
  }
  if (loadedOrganizationId !== organizationId) {
    return <div className="state-panel"><span className="spinner" /> Loading inventory records…</div>;
  }

  return (
    <div className="inventory-workspace">
      {error && <div className="inventory-message error-panel" role="alert">{error}</div>}
      {notice && <div className="inventory-message success-message" role="status">{notice}</div>}
      {page === 'overview' && (
        <>
          <div className="inventory-summary">
            <SummaryCard label="Items" value={String(items.length)} />
            <SummaryCard label="Warehouses" value={String(warehouses.length)} />
            <SummaryCard label="Stocked item locations" value={String(balances.length)} />
          </div>
          <div className="table-heading inventory-section-title">
            <div><h2>On-hand stock</h2><p>Live quantity from open FIFO layers.</p></div>
          </div>
          <BalanceTable rows={balances} />
          {balances.length === 0 && (
            <p className="inventory-hint">No stock is recorded yet. Create an item and warehouse, then record a receipt.</p>
          )}
          <div className="table-heading inventory-section-title">
            <div><h2>Recent movements</h2><p>Latest receipts, issues, and transfers.</p></div>
          </div>
          <MovementTable rows={movements.slice(0, 8)} warehouses={warehouses} />
        </>
      )}
      {page === 'items' && (
        <>
          {canManage && (
            <form className="inventory-form" onSubmit={(event) => void submitItem(event)}>
              <div className="form-intro"><h2>Create item</h2><p>SKUs are unique within the selected organization.</p></div>
              <label>SKU<input required maxLength={64} value={itemSku} onChange={(event) => setItemSku(event.target.value)} /></label>
              <label>Item name<input required maxLength={255} value={itemName} onChange={(event) => setItemName(event.target.value)} /></label>
              <label>Unit of measure<input required maxLength={24} placeholder="e.g. ea, kg, box" value={itemUnit} onChange={(event) => setItemUnit(event.target.value)} /></label>
              <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Create item'}</button>
            </form>
          )}
          <ItemTable rows={items} />
          {!canManage && <p className="inventory-hint">You have read-only access to the item catalog.</p>}
        </>
      )}
      {page === 'warehouses' && (
        <>
          {canManage && (
            <form className="inventory-form" onSubmit={(event) => void submitWarehouse(event)}>
              <div className="form-intro"><h2>Create warehouse</h2><p>Warehouses belong to the selected organization.</p></div>
              <label>Warehouse code<input required maxLength={50} value={warehouseCode} onChange={(event) => setWarehouseCode(event.target.value)} /></label>
              <label>Warehouse name<input required maxLength={255} value={warehouseName} onChange={(event) => setWarehouseName(event.target.value)} /></label>
              <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Create warehouse'}</button>
            </form>
          )}
          <WarehouseTable rows={warehouses} />
          {!canManage && <p className="inventory-hint">You have read-only access to warehouses.</p>}
        </>
      )}
      {page === 'transactions' && (
        <>
          {canTransact && (
            <form className="inventory-form transaction-form" onSubmit={(event) => void submitMovement(event)}>
              <div className="form-intro"><h2>Record stock movement</h2><p>Transactions are recorded in the inventory ledger and cannot be edited or deleted.</p></div>
              <label>Movement type
                <select value={movementKind} onChange={(event) => setMovementKind(event.target.value as MovementKind)}>
                  <option value="receipt">Receipt</option>
                  <option value="issue">Issue</option>
                  <option value="transfer">Transfer</option>
                </select>
              </label>
              <label>Item
                <select required value={itemId || items[0]?.id || ''} onChange={(event) => setItemId(event.target.value)}>
                  <option value="">Select item</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.sku} — {item.name}</option>)}
                </select>
              </label>
              <label>{movementKind === 'transfer' ? 'Source warehouse' : 'Warehouse'}
                <select required value={warehouseId || warehouses[0]?.id || ''} onChange={(event) => {
                  setWarehouseId(event.target.value);
                  if (destinationWarehouseId === event.target.value) setDestinationWarehouseId('');
                }}>
                  <option value="">Select warehouse</option>
                  {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</option>)}
                </select>
              </label>
              {movementKind === 'transfer' && (
                <label>Destination warehouse
                  <select required value={destinationWarehouseId} onChange={(event) => setDestinationWarehouseId(event.target.value)}>
                    <option value="">Select destination</option>
                    {warehouses.filter((warehouse) => warehouse.id !== (warehouseId || warehouses[0]?.id)).map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>Quantity<input required min="0.001" step="0.001" type="number" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
              {movementKind === 'receipt' && (
                <>
                  <label>Unit cost<input required min="0" step="0.0001" type="number" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></label>
                  <label>Cost currency<input required maxLength={3} minLength={3} placeholder="ISO code, e.g. USD" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
                </>
              )}
              <label>Reference (optional)<input maxLength={100} value={reference} onChange={(event) => setReference(event.target.value)} /></label>
              <button className="button button-primary" disabled={saving || !items.length || !warehouses.length} type="submit">
                {saving ? 'Saving…' : `Record ${movementKind}`}
              </button>
            </form>
          )}
          {!canTransact && <p className="inventory-hint">You have read-only access. Ask an administrator for inventory transaction permission.</p>}
          {canTransact && (!items.length || !warehouses.length) && (
            <p className="inventory-hint">Set up at least one item and warehouse before recording stock.</p>
          )}
          <div className="table-heading inventory-section-title">
            <div><h2>Movement history</h2><p>FIFO cost allocations are shown on issues and transfers.</p></div>
          </div>
          <MovementTable rows={movements} warehouses={warehouses} />
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="inventory-summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

function ItemTable({ rows }: { rows: InventoryItem[] }) {
  return (
    <div className="table-card">
      <div className="table-heading"><div><h2>Item catalog</h2><p>Organization inventory item master.</p></div><span className="count-badge">{rows.length} items</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th>SKU</th><th>Item</th><th>Unit</th><th>Status</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}><td className="strong-cell">{row.sku}</td><td>{row.name}</td><td>{row.unit}</td><td>{row.is_active ? 'Active' : 'Inactive'}</td></tr>
        ))}</tbody>
      </table></div>
      {!rows.length && <p className="inventory-empty">No items yet.</p>}
    </div>
  );
}

function WarehouseTable({ rows }: { rows: InventoryWarehouse[] }) {
  return (
    <div className="table-card">
      <div className="table-heading"><div><h2>Warehouses</h2><p>Stock locations available in this organization.</p></div><span className="count-badge">{rows.length} warehouses</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Code</th><th>Warehouse</th><th>Branch</th><th>Status</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}><td className="strong-cell">{row.code}</td><td>{row.name}</td><td>{row.branch_id ?? 'Organization-wide'}</td><td>{row.is_active ? 'Active' : 'Inactive'}</td></tr>
        ))}</tbody>
      </table></div>
      {!rows.length && <p className="inventory-empty">No warehouses yet.</p>}
    </div>
  );
}

function BalanceTable({ rows }: { rows: InventoryBalance[] }) {
  return (
    <div className="table-card">
      <div className="table-scroll"><table>
        <thead><tr><th>SKU</th><th>Item</th><th>Warehouse</th><th>On hand</th><th>Unit</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={`${row.item_id}-${row.warehouse_id}`}>
            <td className="strong-cell">{row.sku}</td><td>{row.item_name}</td>
            <td>{row.warehouse_code} — {row.warehouse_name}</td><td>{row.quantity}</td><td>{row.unit}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function MovementTable({
  rows,
  warehouses,
}: {
  rows: InventoryMovement[];
  warehouses: InventoryWarehouse[];
}) {
  const warehouseName = (id: string | null) => warehouses.find((warehouse) => warehouse.id === id)?.code ?? '—';
  return (
    <div className="table-card">
      <div className="table-scroll"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Item</th><th>From / To</th><th>Quantity</th><th>FIFO cost</th><th>Reference</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}>
            <td>{row.created_at ? new Date(row.created_at).toLocaleString() : '—'}</td>
            <td><span className={`movement-tag ${row.movement_type}`}>{row.movement_type}</span></td>
            <td><span className="strong-cell">{row.sku}</span><span className="table-secondary">{row.item_name}</span></td>
            <td>{row.movement_type === 'receipt'
              ? `→ ${warehouseName(row.destination_warehouse_id)}`
              : row.movement_type === 'issue'
                ? `${warehouseName(row.source_warehouse_id)} →`
                : `${warehouseName(row.source_warehouse_id)} → ${warehouseName(row.destination_warehouse_id)}`}
            </td>
            <td>{row.quantity}</td>
            <td>{row.movement_type === 'receipt'
              ? row.unit_cost && row.currency ? `${row.unit_cost} ${row.currency}/unit` : '—'
              : Object.entries(row.cost_totals).map(([code, amount]) => `${amount} ${code}`).join(', ') || '—'}
            </td>
            <td>{row.reference ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {!rows.length && <p className="inventory-empty">No movements have been recorded.</p>}
    </div>
  );
}
