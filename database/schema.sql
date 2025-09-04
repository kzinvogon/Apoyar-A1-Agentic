-- =====================================================
-- MASTER DATABASE SCHEMA
-- =====================================================
-- This database manages all tenant registrations and references
-- Database name: a1_master

CREATE DATABASE IF NOT EXISTS a1_master;
USE a1_master;

-- Master users table (super admins)
CREATE TABLE master_users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role ENUM('super_admin', 'master_admin') NOT NULL DEFAULT 'master_admin',
    is_active BOOLEAN DEFAULT TRUE,
    last_login DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Tenants table (companies)
CREATE TABLE tenants (
    id INT PRIMARY KEY AUTO_INCREMENT,
    tenant_code VARCHAR(20) UNIQUE NOT NULL, -- e.g., 'apoyar', 'bleckmann'
    company_name VARCHAR(100) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    database_name VARCHAR(50) NOT NULL, -- e.g., 'a1_tenant_apoyar'
    database_host VARCHAR(100) DEFAULT 'localhost',
    database_port INT DEFAULT 3306,
    database_user VARCHAR(50) NOT NULL,
    database_password VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
    max_users INT DEFAULT 100,
    max_tickets INT DEFAULT 1000,
    subscription_plan ENUM('basic', 'professional', 'enterprise') DEFAULT 'basic',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT,
    FOREIGN KEY (created_by) REFERENCES master_users(id)
);

-- Tenant admin users (created by master admin)
CREATE TABLE tenant_admins (
    id INT PRIMARY KEY AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role ENUM('tenant_admin', 'tenant_manager') NOT NULL DEFAULT 'tenant_admin',
    is_active BOOLEAN DEFAULT TRUE,
    last_login DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE KEY unique_tenant_user (tenant_id, username),
    UNIQUE KEY unique_tenant_email (tenant_id, email)
);

-- Master audit log
CREATE TABLE master_audit_log (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    user_type ENUM('master_user', 'tenant_admin') NOT NULL,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES master_users(id)
);

-- Insert default master admin
INSERT INTO master_users (username, email, password_hash, full_name, role) VALUES 
('admin', 'admin@a1master.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'Master Administrator', 'super_admin');

-- Insert sample tenants
INSERT INTO tenants (tenant_code, company_name, display_name, database_name, database_user, database_password, created_by) VALUES 
('apoyar', 'Apoyar', 'Apoyar', 'a1_tenant_apoyar', 'apoyar_user', 'apoyar_pass_123', 1),
('bleckmann', 'Bleckmann', 'Bleckmann', 'a1_tenant_bleckmann', 'bleckmann_user', 'bleckmann_pass_123', 1);

-- =====================================================
-- TENANT DATABASE SCHEMA TEMPLATE
-- =====================================================
-- This template is used to create each tenant's database
-- Database name: a1_tenant_{tenant_code}

-- Example for Apoyar tenant:
-- CREATE DATABASE IF NOT EXISTS a1_tenant_apoyar;
-- USE a1_tenant_apoyar;

-- Users table (tenant users)
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role ENUM('admin', 'expert', 'customer') NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_login DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Experts table (extended user info for experts)
CREATE TABLE experts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    skills JSON, -- Store skills as JSON array
    department VARCHAR(100),
    manager_id INT,
    hire_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (manager_id) REFERENCES experts(id)
);

-- Customers table (extended user info for customers)
CREATE TABLE customers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    company VARCHAR(100),
    phone VARCHAR(20),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- CMDB Items table
CREATE TABLE cmdb_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cmdb_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Configuration Items (CIs) table
CREATE TABLE configuration_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ci_id VARCHAR(50) UNIQUE NOT NULL,
    cmdb_item_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    asset_category VARCHAR(100),
    asset_category_field_name VARCHAR(100),
    field_value TEXT,
    brand_name VARCHAR(100),
    comment TEXT,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Tickets table
CREATE TABLE tickets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ticket_number INT UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    priority ENUM('Low', 'Normal', 'High', 'Critical') DEFAULT 'Normal',
    status ENUM('Open', 'In Progress', 'Pending', 'Resolved', 'Closed') DEFAULT 'Open',
    assignee_id INT,
    customer_id INT NOT NULL,
    cmdb_item_id INT,
    ci_id INT,
    due_date DATE,
    sla_paused BOOLEAN DEFAULT FALSE,
    sla_paused_at DATETIME,
    sla_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sla_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (customer_id) REFERENCES users(id),
    FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id),
    FOREIGN KEY (ci_id) REFERENCES configuration_items(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Ticket activity log
CREATE TABLE ticket_activity (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ticket_id INT NOT NULL,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Tenant audit log
CREATE TABLE tenant_audit_log (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Insert default tenant admin user
-- INSERT INTO users (username, email, password_hash, full_name, role) VALUES 
-- ('admin', 'admin@tenant.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'Tenant Administrator', 'admin');

-- Insert default expert user
-- INSERT INTO users (username, email, password_hash, full_name, role) VALUES 
-- ('expert', 'expert@tenant.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'Expert User', 'expert');

-- Insert default customer user
-- INSERT INTO users (username, email, password_hash, full_name, role) VALUES 
-- ('customer', 'customer@tenant.com', '$2b$10$rQZ8K9vL2mN3pQ4sT5uV6w', 'Customer User', 'customer');

