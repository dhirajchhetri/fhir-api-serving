-- Transactional shape for the patient-care and tasking aggregates.
-- The reference API keeps these aggregates in memory so it can run without
-- a database. This is the schema the Aurora cluster in the CDK stack hosts.

CREATE TABLE patients (
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  mrn TEXT NOT NULL,
  family_name TEXT NOT NULL,
  given_name TEXT NOT NULL,
  birth_date DATE NOT NULL,
  gender TEXT NOT NULL,
  PRIMARY KEY (tenant_id, patient_id)
);

CREATE TABLE wounds (
  tenant_id TEXT NOT NULL,
  wound_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  clinician_id TEXT NOT NULL,
  wound_type TEXT NOT NULL,
  onset_date DATE NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (tenant_id, wound_id)
);

CREATE TABLE assessments (
  tenant_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  wound_id TEXT NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL,
  clinician_id TEXT NOT NULL,
  tissue_type TEXT NOT NULL,
  offloading BOOLEAN NOT NULL,
  closed BOOLEAN NOT NULL,
  PRIMARY KEY (tenant_id, assessment_id)
);

CREATE TABLE measurements (
  tenant_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  code TEXT NOT NULL,
  value_numeric DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  PRIMARY KEY (tenant_id, assessment_id, code)
);

CREATE TABLE care_tasks (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  wound_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  clinician_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  due_date DATE NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, task_id)
);

CREATE TABLE risk_scores (
  score_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  wound_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  band TEXT NOT NULL,
  model_version TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  decision_support_only BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE domain_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
