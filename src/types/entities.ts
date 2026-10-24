/**
 * Base entity interface that all entities must extend
 */
export interface BaseEntity {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Customer entity interface
 */
export interface Customer extends BaseEntity {
  name: string;
  email: string;
  phone?: string;
  address?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  status: 'active' | 'inactive' | 'suspended';
  customerType: 'individual' | 'business';
  taxId?: string;
  creditLimit?: number;
}

/**
 * Order entity interface
 */
export interface Order extends BaseEntity {
  customerId: string;
  orderNumber: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  orderDate: Date;
  totalAmount: number;
  currency: string;
  items: OrderItem[];
  shippingAddress?: Address;
  billingAddress?: Address;
  paymentMethod?: string;
  notes?: string;
}

/**
 * Order item interface
 */
export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  sku?: string;
}

/**
 * Product entity interface
 */
export interface Product extends BaseEntity {
  name: string;
  description?: string;
  sku: string;
  price: number;
  currency: string;
  category: string;
  status: 'active' | 'inactive' | 'discontinued';
  inventory?: {
    quantity: number;
    reserved: number;
    available: number;
  };
  dimensions?: {
    weight: number;
    length: number;
    width: number;
    height: number;
  };
}

/**
 * Invoice entity interface
 */
export interface Invoice extends BaseEntity {
  customerId: string;
  orderId?: string;
  invoiceNumber: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  issueDate: Date;
  dueDate: Date;
  totalAmount: number;
  paidAmount: number;
  currency: string;
  lineItems: InvoiceLineItem[];
  paymentTerms?: string;
  notes?: string;
}

/**
 * Invoice line item interface
 */
export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  taxRate?: number;
  taxAmount?: number;
}

/**
 * Address interface
 */
export interface Address {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

/**
 * Contact entity interface
 */
export interface Contact extends BaseEntity {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  title?: string;
  company?: string;
  customerId?: string;
  type: 'primary' | 'billing' | 'shipping' | 'technical';
}

/**
 * Payment entity interface
 */
export interface Payment extends BaseEntity {
  customerId: string;
  invoiceId?: string;
  orderId?: string;
  amount: number;
  currency: string;
  paymentDate: Date;
  paymentMethod: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  transactionId?: string;
  reference?: string;
  notes?: string;
}

/**
 * Union type of all supported entities
 */
export type SupportedEntity = 
  | Customer 
  | Order 
  | Product 
  | Invoice 
  | Contact 
  | Payment;

/**
 * Entity type mapping for type-safe operations
 */
export interface EntityTypeMap extends Record<string, BaseEntity> {
  customer: Customer;
  order: Order;
  product: Product;
  invoice: Invoice;
  contact: Contact;
  payment: Payment;
}

/**
 * Entity type names
 */
export type EntityType = keyof EntityTypeMap;

/**
 * Generic type helper to get entity type from entity type name
 */
export type GetEntityType<T extends EntityType> = EntityTypeMap[T];