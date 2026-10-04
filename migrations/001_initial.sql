-- migrations/001_initial.sql
-- PostgreSQL schema for Prepaid Smart Fuel Dispensing System

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. users (customers)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) UNIQUE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    last_login TIMESTAMP WITH TIME ZONE
);

-- 2. stations
CREATE TABLE stations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 3. station_users (staff)
CREATE TABLE station_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    last_login TIMESTAMP WITH TIME ZONE
);

-- 4. wallets
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    available_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    reserved_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 5. wallet_transactions
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    station_id UUID REFERENCES stations(id),
    type VARCHAR(30) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    balance_before NUMERIC(12,2) NOT NULL,
    balance_after NUMERIC(12,2) NOT NULL,
    reference VARCHAR(50) NOT NULL,
    performed_by VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 6. fuel_types
CREATE TABLE fuel_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL UNIQUE,
    price_per_litre NUMERIC(8,3) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 7. pumps
CREATE TABLE pumps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
    pump_number INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    fuel_type_id UUID REFERENCES fuel_types(id),
    controller_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (station_id, pump_number)
);

-- 8. fuel_requests
CREATE TABLE fuel_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_reference VARCHAR(50) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    station_id UUID REFERENCES stations(id),
    fuel_type_id UUID REFERENCES fuel_types(id),
    pump_id UUID REFERENCES pumps(id),
    requested_litres NUMERIC(8,3) NOT NULL,
    requested_amount NUMERIC(12,2) NOT NULL,
    price_per_litre NUMERIC(8,3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 9. fuel_transactions
CREATE TABLE fuel_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_reference VARCHAR(50) UNIQUE NOT NULL,
    request_id UUID REFERENCES fuel_requests(id),
    user_id UUID REFERENCES users(id),
    station_id UUID REFERENCES stations(id),
    pump_id UUID REFERENCES pumps(id),
    fuel_type_id UUID REFERENCES fuel_types(id),
    price_per_litre NUMERIC(8,3) NOT NULL,
    authorized_litres NUMERIC(8,3) NOT NULL,
    actual_litres NUMERIC(8,3),
    authorized_amount NUMERIC(12,2) NOT NULL,
    final_amount NUMERIC(12,2),
    refund_amount NUMERIC(12,2),
    status VARCHAR(20) NOT NULL DEFAULT 'AUTHORIZED',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 10. audit_logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    station_user_id UUID REFERENCES station_users(id),
    station_id UUID REFERENCES stations(id),
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    description TEXT,
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for faster look‑ups
CREATE INDEX idx_fuel_requests_user ON fuel_requests(user_id);
CREATE INDEX idx_fuel_requests_station ON fuel_requests(station_id);
CREATE INDEX idx_fuel_transactions_user ON fuel_transactions(user_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
