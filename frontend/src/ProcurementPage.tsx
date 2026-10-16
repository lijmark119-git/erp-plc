import { useCallback, useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import {
  createPurchaseOrder,
  createSupplier,
  getInventoryItems,
  getInventoryWarehouses,
  getPurchaseOrders,
  getSuppliers,
  receivePurchaseOrderLine,
  type InventoryItem,
  type InventoryWarehouse,
  type PurchaseOrderRecord,
  type SupplierRecord,
} from './api';

type ProcurementPageProps = {
  organizationId: string;
  page: string;
  canManage: boolean;
  canOrder: boolean;
  canReceive: boolean;
  canReadInventory: boolean;
};

type OrderDraftLine = { key: number; itemId: string; quantity: string; unitCost: string };

export default function ProcurementPage({
  organizationId,
  page,
  canManage,
  canOrder,
  canReceive,
  canReadInventory,
}: ProcurementPageProps) {
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRecord[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<InventoryWarehouse[]>([]);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [supplierCode, setSupplierCode] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierEmail, setSupplierEmail] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [draftLines, setDraftLines] = useState<OrderDraftLine[]>([
    { key: 0, itemId: '', quantity: '', unitCost: '' },
  ]);
  const [selectedWarehouses, setSelectedWarehouses] = useState<Record<string, string>>({});
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [supplierRows, orderRows, itemRows, warehouseRows] = await Promise.all([
      getSuppliers(organizationId),
      getPurchaseOrders(organizationId),
      canReadInventory ? getInventoryItems(organizationId) : Promise.resolve([]),
      canReadInventory ? getInventoryWarehouses(organizationId) : Promise.resolve([]),
    ]);
    setSuppliers(supplierRows);
    setOrders(orderRows);
    setItems(itemRows);
    setWarehouses(warehouseRows);
    setLoadedOrganizationId(organizationId);
    setLoadError('');
  }, [organizationId, canReadInventory]);

  useEffect(() => {
    let active = true;
    if (!organizationId) return () => { active = false; };
    Promise.all([
      getSuppliers(organizationId),
      getPurchaseOrders(organizationId),
      canReadInventory ? getInventoryItems(organizationId) : Promise.resolve([]),
      canReadInventory ? getInventoryWarehouses(organizationId) : Promise.resolve([]),
    ])
      .then(([supplierRows, orderRows, itemRows, warehouseRows]) => {
        if (!active) return;
        setSuppliers(supplierRows);
        setOrders(orderRows);
        setItems(itemRows);
        setWarehouses(warehouseRows);
        setLoadedOrganizationId(organizationId);
        setLoadError('');
      })
      .catch((loadError: unknown) => {
        if (active) setLoadError(loadError instanceof Error ? loadError.message : 'Procurement could not be loaded.');
      });
    return () => { active = false; };
  }, [organizationId, canReadInventory]);

  async function submitSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await createSupplier({
        organization_id: organizationId,
        code: supplierCode,
        name: supplierName,
        email: supplierEmail || undefined,
        phone: supplierPhone || undefined,
      });
      setSupplierCode('');
      setSupplierName('');
      setSupplierEmail('');
      setSupplierPhone('');
      setNotice('Supplier created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The supplier could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (!selectedSupplierId) throw new Error('Create or select a supplier before issuing an order.');
      if (!items.length) throw new Error('Create an inventory item before issuing a purchase order.');
      await createPurchaseOrder({
        organization_id: organizationId,
        supplier_id: selectedSupplierId,
        currency: currency.trim().toUpperCase(),
        lines: draftLines.map((line) => {
          if (!line.itemId) throw new Error('Select an inventory item for every order line.');
          if (!line.quantity || !line.unitCost) throw new Error('Enter the quantity and unit cost for every order line.');
          return { item_id: line.itemId, quantity: line.quantity, unit_cost: line.unitCost };
        }),
      });
      setDraftLines([{ key: Date.now(), itemId: '', quantity: '', unitCost: '' }]);
      setNotice('Purchase order issued.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The purchase order could not be issued.');
    } finally {
      setSaving(false);
    }
  }

  async function receiveLine(order: PurchaseOrderRecord, lineId: string) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const warehouseId = selectedWarehouses[lineId] || warehouses[0]?.id || '';
      const quantity = receiveQuantities[lineId] ?? '';
      if (!warehouseId) throw new Error('Select an inventory warehouse for the delivery.');
      if (!quantity) throw new Error('Enter the quantity being received.');
      await receivePurchaseOrderLine({
        organization_id: organizationId,
        order_id: order.id,
        line_id: lineId,
        warehouse_id: warehouseId,
        quantity,
      });
      setReceiveQuantities((current) => ({ ...current, [lineId]: '' }));
      setNotice(`Delivery recorded for ${order.order_number}; inventory FIFO stock was updated.`);
      await refresh();
    } catch (receiveError) {
      setError(receiveError instanceof Error ? receiveError.message : 'The purchase order delivery could not be received.');
    } finally {
      setSaving(false);
    }
  }

  if (!organizationId) return <div className="state-panel">Select an organization context to use procurement.</div>;
  if (loadError) {
    return (
      <div className="state-panel error-panel" role="alert">
        <span>{loadError}</span>
        <button className="button button-secondary" onClick={() => void refresh().catch((retryError: unknown) => {
          setLoadError(retryError instanceof Error ? retryError.message : 'Procurement could not be loaded.');
        })}>Retry</button>
      </div>
    );
  }
  if (loadedOrganizationId !== organizationId) {
    return <div className="state-panel"><span className="spinner" /> Loading procurement records…</div>;
  }

  const openOrders = orders.filter((order) => order.status !== 'received');
  return (
    <div className="inventory-workspace">
      {error && <div className="inventory-message error-panel" role="alert">{error}</div>}
      {notice && <div className="inventory-message success-message" role="status">{notice}</div>}

      {page === 'overview' && (
        <>
          <div className="inventory-summary">
            <SummaryCard label="Active suppliers" value={String(suppliers.length)} />
            <SummaryCard label="Purchase orders" value={String(orders.length)} />
            <SummaryCard label="Awaiting delivery" value={String(openOrders.length)} />
          </div>
          <section className="table-card">
            <div className="table-heading"><div><h2>Open purchase orders</h2><p>Orders still awaiting some or all deliveries.</p></div></div>
            <OrderTable orders={openOrders} />
          </section>
        </>
      )}

      {page === 'suppliers' && (
        <>
          {canManage && (
            <form className="inventory-form" onSubmit={(event) => void submitSupplier(event)}>
              <div className="form-intro"><h2>Create supplier</h2><p>Supplier codes are unique within the selected company.</p></div>
              <label>Supplier code<input required maxLength={50} value={supplierCode} onChange={(event) => setSupplierCode(event.target.value)} /></label>
              <label>Supplier name<input required maxLength={255} value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /></label>
              <label>Email<input type="email" maxLength={255} value={supplierEmail} onChange={(event) => setSupplierEmail(event.target.value)} /></label>
              <label>Phone<input maxLength={50} value={supplierPhone} onChange={(event) => setSupplierPhone(event.target.value)} /></label>
              <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Create supplier'}</button>
            </form>
          )}
          <section className="table-card">
            <div className="table-heading"><div><h2>Suppliers</h2><p>Active suppliers available for purchasing.</p></div></div>
            <SupplierTable suppliers={suppliers} />
          </section>
          {!canManage && <p className="inventory-hint">You have read-only supplier access.</p>}
        </>
      )}

      {page === 'orders' && (
        <>
          {canOrder && (
            <form className="inventory-form procurement-order-form" onSubmit={(event) => void submitOrder(event)}>
              <div className="form-intro"><h2>Issue purchase order</h2><p>Issued orders can be partially received into an inventory warehouse.</p></div>
              <label>Supplier
                <select required value={selectedSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)}>
                  <option value="">Select supplier</option>
                  {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} — {supplier.name}</option>)}
                </select>
              </label>
              <label>Currency<input required pattern="[A-Za-z]{3}" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
              {!canReadInventory && <p className="inventory-hint">Grant inventory read permission to select items and create purchase orders.</p>}
              {draftLines.map((line, index) => (
                <div className="procurement-line" key={line.key}>
                  <label>Item
                    <select required value={line.itemId} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'itemId', event.target.value)}>
                      <option value="">Select item</option>
                      {items.map((item) => <option key={item.id} value={item.id}>{item.sku} — {item.name}</option>)}
                    </select>
                  </label>
                  <label>Quantity<input required min="0.001" step="0.001" type="number" value={line.quantity} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'quantity', event.target.value)} /></label>
                  <label>Unit cost<input required min="0" step="0.0001" type="number" value={line.unitCost} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'unitCost', event.target.value)} /></label>
                  {draftLines.length > 1 && <button className="button button-secondary" type="button" onClick={() => setDraftLines((current) => current.filter((row) => row.key !== line.key))}>Remove line {index + 1}</button>}
                </div>
              ))}
              <button className="button button-secondary" type="button" onClick={() => setDraftLines((current) => [...current, { key: Date.now(), itemId: '', quantity: '', unitCost: '' }])}>Add order line</button>
              <button className="button button-primary" disabled={saving || !canReadInventory || !suppliers.length || !items.length} type="submit">{saving ? 'Saving…' : 'Issue purchase order'}</button>
            </form>
          )}
          {!suppliers.length && <p className="inventory-hint">Create a supplier before issuing a purchase order.</p>}
          <section className="procurement-orders">
            <div className="section-heading"><div><h2>Purchase orders</h2><p>Track quantities ordered and delivered.</p></div></div>
            {orders.length ? orders.map((order) => (
              <article className="table-card procurement-order-card" key={order.id}>
                <header className="procurement-order-heading">
                  <div><strong>{order.order_number}</strong><span>{order.supplier_code} — {order.supplier_name} · {order.currency}</span></div>
                  <span className={`movement-tag ${order.status === 'received' ? 'receipt' : ''}`}>{order.status.replace('_', ' ')}</span>
                </header>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Unit cost</th><th>Delivery</th></tr></thead>
                    <tbody>{order.lines.map((line) => {
                      const outstanding = Number(line.ordered_quantity) - Number(line.received_quantity);
                      return (
                        <tr key={line.id}>
                          <td>{line.sku} — {line.item_name}</td>
                          <td>{line.ordered_quantity} {line.unit}</td>
                          <td>{line.received_quantity} {line.unit}</td>
                          <td>{line.unit_cost} {order.currency}</td>
                          <td>
                            {outstanding > 0 && canReceive ? (
                              <div className="procurement-receive-control">
                                <select aria-label={`Warehouse for ${line.sku}`} value={selectedWarehouses[line.id] ?? warehouses[0]?.id ?? ''} onChange={(event) => setSelectedWarehouses((current) => ({ ...current, [line.id]: event.target.value }))}>
                                  <option value="">Select warehouse</option>
                                  {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</option>)}
                                </select>
                                <input aria-label={`Receive quantity for ${line.sku}`} type="number" min="0.001" max={outstanding} step="0.001" placeholder={`Max ${outstanding}`} value={receiveQuantities[line.id] ?? ''} onChange={(event) => setReceiveQuantities((current) => ({ ...current, [line.id]: event.target.value }))} />
                                <button className="button button-primary" disabled={saving || !warehouses.length} onClick={() => void receiveLine(order, line.id)} type="button">Receive</button>
                              </div>
                            ) : outstanding > 0 ? `${outstanding.toFixed(3)} remaining` : 'Complete'}
                          </td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              </article>
            )) : <div className="inventory-empty">No purchase orders yet.</div>}
            {canReceive && !canReadInventory && <p className="inventory-hint">Grant inventory read permission to select a receiving warehouse.</p>}
          </section>
        </>
      )}
    </div>
  );
}

function updateDraftLine(
  setLines: Dispatch<SetStateAction<OrderDraftLine[]>>,
  key: number,
  field: 'itemId' | 'quantity' | 'unitCost',
  value: string,
) {
  setLines((current) => current.map((line) => line.key === key ? { ...line, [field]: value } : line));
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="inventory-summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

function SupplierTable({ suppliers }: { suppliers: SupplierRecord[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Code</th><th>Supplier</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>
          {suppliers.map((supplier) => <tr key={supplier.id}><td>{supplier.code}</td><td>{supplier.name}</td><td>{supplier.email || '—'}</td><td>{supplier.phone || '—'}</td></tr>)}
          {!suppliers.length && <tr><td colSpan={4}>No suppliers have been created.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function OrderTable({ orders }: { orders: PurchaseOrderRecord[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Purchase order</th><th>Supplier</th><th>Status</th><th>Lines</th></tr></thead>
        <tbody>
          {orders.map((order) => <tr key={order.id}><td>{order.order_number}</td><td>{order.supplier_name}</td><td>{order.status.replace('_', ' ')}</td><td>{order.lines.length}</td></tr>)}
          {!orders.length && <tr><td colSpan={4}>There are no open orders.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
