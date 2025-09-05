-- A1 Support Dashboard - Simple PostgreSQL Schema

-- Master Admin Users Table
CREATE TABLE IF NOT EXISTS master_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    role VARCHAR(20) DEFAULT 'master_admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) UNIQUE NOT NULL,
    company_name VARCHAR(100) NOT NULL,
    domain VARCHAR(100),
    contact_email VARCHAR(100),
    contact_phone VARCHAR(20),
    address TEXT,
    status VARCHAR(20) DEFAULT 'active',
    email_processing_enabled BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription Plans Table
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    max_users INTEGER NOT NULL,
    max_tickets INTEGER NOT NULL,
    max_storage_gb INTEGER NOT NULL,
    features JSONB DEFAULT '[]',
    price_monthly DECIMAL(10,2) NOT NULL,
    price_yearly DECIMAL(10,2) NOT NULL,
    is_trial BOOLEAN DEFAULT false,
    trial_days INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant Subscriptions Table
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES subscription_plans(id),
    status VARCHAR(20) DEFAULT 'active',
    start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_date TIMESTAMP,
    trial_end_date TIMESTAMP,
    auto_renew BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenant Users Table
CREATE TABLE IF NOT EXISTS tenant_users (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, username),
    UNIQUE(tenant_id, email)
);

-- Support Tickets Table
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    ticket_id VARCHAR(20) UNIQUE NOT NULL,
    tenant_id VARCHAR(50) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES tenant_users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    priority VARCHAR(20) DEFAULT 'medium',
    status VARCHAR(20) DEFAULT 'open',
    category VARCHAR(50),
    assigned_to INTEGER REFERENCES tenant_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

-- CMDB Items Table
CREATE TABLE IF NOT EXISTS cmdb_items (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    location VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active',
    serial_number VARCHAR(100),
    model VARCHAR(100),
    vendor VARCHAR(100),
    purchase_date DATE,
    warranty_end_date DATE,
    assigned_to INTEGER REFERENCES tenant_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Usage Tracking Table
CREATE TABLE IF NOT EXISTS usage_tracking (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    metric_type VARCHAR(50) NOT NULL,
    current_count INTEGER DEFAULT 0,
    limit_count INTEGER NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, metric_type)
);
