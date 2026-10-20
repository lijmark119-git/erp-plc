CREATE TABLE IF NOT EXISTS procurement_supplier_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES procurement_suppliers(id) ON DELETE CASCADE,
  document_type VARCHAR(80) NOT NULL,
  document_name VARCHAR(180) NOT NULL,
  reference_url TEXT,
  expiry_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_procurement_supplier_documents_expiry
  ON procurement_supplier_documents (organization_id, expiry_date)
  WHERE expiry_date IS NOT NULL;
