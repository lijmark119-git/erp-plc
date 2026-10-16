import { useCallback, useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import {
  createCustomer,
  createSalesOrder,
  fulfillSalesOrderLine,
  getCustomers,
  getInventoryItems,
  getInventoryWarehouses,
  getSalesOrders,
  type CustomerRecord,
  type InventoryItem,
  type InventoryWarehouse,
  type SalesOrderRecord,
} from './api';

type SalesPageProps = {
  organizationId: string;
  page: string;
  canManageCustomers: boolean;
  canOrder: boolean;
  canFulfill: boolean;
  canReadInventory: boolean;
};

type DraftLine = { key: number; itemId: string; quantity: string; unitPrice: string };

export default function SalesPage({
  organizationId,
  page,
  canManageCustomers,
  canOrder,
  canFulfill,
  canReadInventory,
}: SalesPageProps) {
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [orders, setOrders] = useState<SalesOrderRecord[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<InventoryWarehouse[]>([]);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [customerCode, setCustomerCode] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([{ key: 0, itemId: '', quantity: '', unitPrice: '' }]);
  const [selectedWarehouses, setSelectedWarehouses] = useState<Record<string, string>>({});
  const [shipmentQuantities, setShipmentQuantities] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [customerRows, orderRows, itemRows, warehouseRows] = await Promise.all([
      getCustomers(organizationId),
      getSalesOrders(organizationId),
      canReadInventory ? getInventoryItems(organizationId) : Promise.resolve([]),
      canReadInventory ? getInventoryWarehouses(organizationId) : Promise.resolve([]),
    ]);
    setCustomers(customerRows);
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
      getCustomers(organizationId),
      getSalesOrders(organizationId),
      canReadInventory ? getInventoryItems(organizationId) : Promise.resolve([]),
      canReadInventory ? getInventoryWarehouses(organizationId) : Promise.resolve([]),
    ])
      .then(([customerRows, orderRows, itemRows, warehouseRows]) => {
        if (!active) return;
        setCustomers(customerRows);
        setOrders(orderRows);
        setItems(itemRows);
        setWarehouses(warehouseRows);
        setLoadedOrganizationId(organizationId);
        setLoadError('');
      })
      .catch((loadError: unknown) => {
        if (active) setLoadError(loadError instanceof Error ? loadError.message : 'Sales records could not be loaded.');
      });
    return () => { active = false; };
  }, [organizationId, canReadInventory]);

  async function submitCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await createCustomer({
        organization_id: organizationId,
        code: customerCode,
        name: customerName,
        email: customerEmail || undefined,
        phone: customerPhone || undefined,
      });
      setCustomerCode('');
      setCustomerName('');
      setCustomerEmail('');
      setCustomerPhone('');
      setNotice('Customer created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The customer could not be created.');
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
      if (!selectedCustomerId) throw new Error('Create or select a customer before creating a sales order.');
      if (!items.length) throw new Error('Create an inventory item before creating a sales order.');
      await createSalesOrder({
        organization_id: organizationId,
        customer_id: selectedCustomerId,
        currency: currency.trim().toUpperCase(),
        lines: draftLines.map((line) => {
          if (!line.itemId) throw new Error('Select an inventory item for every order line.');
          if (!line.quantity || !line.unitPrice) throw new Error('Enter the quantity and unit price for every order line.');
          return { item_id: line.itemId, quantity: line.quantity, unit_price: line.unitPrice };
        }),
      });
      setDraftLines([{ key: Date.now(), itemId: '', quantity: '', unitPrice: '' }]);
      setNotice('Sales order created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The sales order could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function fulfillLine(order: SalesOrderRecord, lineId: string) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const warehouseId = selectedWarehouses[lineId] || warehouses[0]?.id || '';
      const quantity = shipmentQuantities[lineId] ?? '';
      if (!warehouseId) throw new Error('Select an authorized warehouse for the shipment.');
      if (!quantity) throw new Error('Enter the quantity being shipped.');
      const result = await fulfillSalesOrderLine({
        organization_id: organizationId,
        order_id: order.id,
        line_id: lineId,
        warehouse_id: warehouseId,
        quantity,
      });
      setShipmentQuantities((current) => ({ ...current, [lineId]: '' }));
      const costs = Object.entries(result.inventory_movement.cost_totals)
        .map(([code, amount]) => `${amount} ${code}`)
        .join(', ');
      setNotice(`Shipment recorded for ${order.order_number}. FIFO cost: ${costs || 'no cost layer value'}.`);
      await refresh();
    } catch (shipError) {
      setError(shipError instanceof Error ? shipError.message : 'The shipment could not be recorded.');
    } finally {
      setSaving(false);
    }
  }

  if (!organizationId) return <div className="state-panel">Select an organization context to use Sales.</div>;
  if (loadError) {
    return (
      <div className="state-panel error-panel" role="alert">
        <span>{loadError}</span>
        <button className="button button-secondary" onClick={() => void refresh().catch((retryError: unknown) => {
          setLoadError(retryError instanceof Error ? retryError.message : 'Sales records could not be loaded.');
        })}>Retry</button>
      </div>
    );
  }
  if (loadedOrganizationId !== organizationId) {
    return <div className="state-panel"><span className="spinner" /> Loading sales records…</div>;
  }

  const openOrders = orders.filter((order) => order.status !== 'shipped');
  return (
    <div className="inventory-workspace">
      {error && <div className="inventory-message error-panel" role="alert">{error}</div>}
      {notice && <div className="inventory-message success-message" role="status">{notice}</div>}
      {page === 'overview' && (
        <>
          <div className="inventory-summary">
            <SummaryCard label="Active customers" value={String(customers.length)} />
            <SummaryCard label="Sales orders" value={String(orders.length)} />
            <SummaryCard label="Awaiting shipment" value={String(openOrders.length)} />
          </div>
          <OrderList orders={openOrders} />
        </>
      )}
      {page === 'customers' && (
        <>
          {canManageCustomers && (
            <form className="inventory-form" onSubmit={(event) => void submitCustomer(event)}>
              <div className="form-intro"><h2>Create customer</h2><p>Customer codes are unique within the selected company.</p></div>
              <label>Customer code<input required maxLength={50} value={customerCode} onChange={(event) => setCustomerCode(event.target.value)} /></label>
              <label>Customer name<input required maxLength={255} value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
              <label>Email<input type="email" maxLength={255} value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} /></label>
              <label>Phone<input maxLength={50} value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label>
              <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Create customer'}</button>
            </form>
          )}
          <section className="table-card">
            <div className="table-heading"><div><h2>Customers</h2><p>Active customer accounts.</p></div></div>
            <CustomerTable customers={customers} />
          </section>
          {!canManageCustomers && <p className="inventory-hint">You have read-only customer access.</p>}
        </>
      )}
      {page === 'orders' && (
        <>
          {canOrder && (
            <form className="inventory-form procurement-order-form" onSubmit={(event) => void submitOrder(event)}>
              <div className="form-intro"><h2>Create sales order</h2><p>Orders can be partially shipped from authorized inventory warehouses.</p></div>
              <label>Customer
                <select required value={selectedCustomerId} onChange={(event) => setSelectedCustomerId(event.target.value)}>
                  <option value="">Select customer</option>
                  {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} — {customer.name}</option>)}
                </select>
              </label>
              <label>Currency<input required pattern="[A-Za-z]{3}" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
              {!canReadInventory && <p className="inventory-hint">Grant inventory read permission to select items for orders.</p>}
              {draftLines.map((line, index) => (
                <div className="procurement-line" key={line.key}>
                  <label>Item
                    <select required value={line.itemId} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'itemId', event.target.value)}>
                      <option value="">Select item</option>
                      {items.map((item) => <option key={item.id} value={item.id}>{item.sku} — {item.name}</option>)}
                    </select>
                  </label>
                  <label>Quantity<input required min="0.001" step="0.001" type="number" value={line.quantity} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'quantity', event.target.value)} /></label>
                  <label>Unit price<input required min="0" step="0.0001" type="number" value={line.unitPrice} onChange={(event) => updateDraftLine(setDraftLines, line.key, 'unitPrice', event.target.value)} /></label>
                  {draftLines.length > 1 && <button className="button button-secondary" type="button" onClick={() => setDraftLines((current) => current.filter((row) => row.key !== line.key))}>Remove line {index + 1}</button>}
                </div>
              ))}
              <button className="button button-secondary" type="button" onClick={() => setDraftLines((current) => [...current, { key: Date.now(), itemId: '', quantity: '', unitPrice: '' }])}>Add order line</button>
              <button className="button button-primary" disabled={saving || !canReadInventory || !customers.length || !items.length} type="submit">{saving ? 'Saving…' : 'Create sales order'}</button>
            </form>
          )}
          {!customers.length && <p className="inventory-hint">Create a customer before creating a sales order.</p>}
          <OrderList
            orders={orders}
            canFulfill={canFulfill}
            warehouses={warehouses}
            selectedWarehouses={selectedWarehouses}
            shipmentQuantities={shipmentQuantities}
            saving={saving}
            onWarehouseChange={(lineId, warehouseId) => setSelectedWarehouses((current) => ({ ...current, [lineId]: warehouseId }))}
            onQuantityChange={(lineId, quantity) => setShipmentQuantities((current) => ({ ...current, [lineId]: quantity }))}
            onFulfill={fulfillLine}
          />
          {canFulfill && !canReadInventory && <p className="inventory-hint">Grant inventory read permission to select a shipping warehouse.</p>}
        </>
      )}
    </div>
  );
}

function updateDraftLine(
  setLines: Dispatch<SetStateAction<DraftLine[]>>,
  key: number,
  field: 'itemId' | 'quantity' | 'unitPrice',
  value: string,
) {
  setLines((current) => current.map((line) => line.key === key ? { ...line, [field]: value } : line));
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="inventory-summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

function CustomerTable({ customers }: { customers: CustomerRecord[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Code</th><th>Customer</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>
          {customers.map((customer) => <tr key={customer.id}><td>{customer.code}</td><td>{customer.name}</td><td>{customer.email || '—'}</td><td>{customer.phone || '—'}</td></tr>)}
          {!customers.length && <tr><td colSpan={4}>No customers have been created.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function OrderList({
  orders,
  canFulfill = false,
  warehouses = [],
  selectedWarehouses = {},
  shipmentQuantities = {},
  saving = false,
  onWarehouseChange,
  onQuantityChange,
  onFulfill,
}: {
  orders: SalesOrderRecord[];
  canFulfill?: boolean;
  warehouses?: InventoryWarehouse[];
  selectedWarehouses?: Record<string, string>;
  shipmentQuantities?: Record<string, string>;
  saving?: boolean;
  onWarehouseChange?: (lineId: string, warehouseId: string) => void;
  onQuantityChange?: (lineId: string, quantity: string) => void;
  onFulfill?: (order: SalesOrderRecord, lineId: string) => void;
}) {
  return (
    <section className="procurement-orders">
      <div className="section-heading"><div><h2>Sales orders</h2><p>Track customer demand and shipment fulfillment.</p></div></div>
      {orders.length ? orders.map((order) => (
        <article className="table-card procurement-order-card" key={order.id}>
          <header className="procurement-order-heading">
            <div><strong>{order.order_number}</strong><span>{order.customer_code} — {order.customer_name} · {order.currency}</span></div>
            <span className={`movement-tag ${order.status === 'shipped' ? 'receipt' : ''}`}>{order.status.replace('_', ' ')}</span>
          </header>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Item</th><th>Ordered</th><th>Shipped</th><th>Unit price</th><th>Shipment</th></tr></thead>
              <tbody>{order.lines.map((line) => {
                const outstanding = Number(line.ordered_quantity) - Number(line.shipped_quantity);
                return (
                  <tr key={line.id}>
                    <td>{line.sku} — {line.item_name}</td>
                    <td>{line.ordered_quantity} {line.unit}</td>
                    <td>{line.shipped_quantity} {line.unit}</td>
                    <td>{line.unit_price} {order.currency}</td>
                    <td>
                      {outstanding > 0 && canFulfill && onFulfill && onQuantityChange && onWarehouseChange ? (
                        <div className="procurement-receive-control">
                          <select aria-label={`Warehouse for ${line.sku}`} value={selectedWarehouses[line.id] ?? warehouses[0]?.id ?? ''} onChange={(event) => onWarehouseChange(line.id, event.target.value)}>
                            <option value="">Select warehouse</option>
                            {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</option>)}
                          </select>
                          <input aria-label={`Ship quantity for ${line.sku}`} type="number" min="0.001" max={outstanding} step="0.001" placeholder={`Max ${outstanding}`} value={shipmentQuantities[line.id] ?? ''} onChange={(event) => onQuantityChange(line.id, event.target.value)} />
                          <button className="button button-primary" disabled={saving || !warehouses.length} onClick={() => onFulfill(order, line.id)} type="button">Ship</button>
                        </div>
                      ) : outstanding > 0 ? `${outstanding.toFixed(3)} remaining` : 'Complete'}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </article>
      )) : <div className="inventory-empty">No sales orders have been created.</div>}
    </section>
  );
}
