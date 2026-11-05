# Wound-care FHIR API

A reference service for a wound-care record: a FHIR R4 read API, operational analytics over a governed metrics layer, and a clinician-facing risk score. It is a personal project with synthetic records only. It is not a clinical product, it has not been used in production, and it is not a certification claim.

The diagram in [docs/architecture.html](docs/architecture.html) is the picture of the deployed shape. The process you can run on a laptop implements the same boundaries with in-memory and local stand-ins, so the tests do not need an AWS account.

## Architecture

Clinicians and partner apps share one API. Clinical reads are FHIR R4. Operational questions go through a query builder that can only render reviewed SQL templates. Risk scores come back on the same API and are labelled as decision support.

```mermaid
flowchart LR
  client[Partner or patient app] -->|FHIR R4| gw[API Gateway]
  clinician[Clinician client] -->|JSON| gw
  gw --> bff[NestJS service on ECS Fargate]
  bff --> care[Patient care and tasking]
  care -->|domain events| bus[EventBridge]
  bus --> mapper[Lambda FHIR mapper]
  mapper --> hl[(AWS HealthLake)]
  bff -->|FHIR read| hl
  hl -->|NDJSON export| raw[(S3 raw)]
  raw --> glue[Glue ETL]
  glue --> curated[(S3 curated Parquet)]
  curated --> catalog[Glue Data Catalog]
  catalog --> athena[Athena workgroup]
  bff --> builder[Query builder]
  builder -->|templated SQL| athena
  builder --- graph[(Neptune semantic graph)]
  bff --> score[SageMaker endpoint]
  bff --> cache[(ElastiCache Redis)]
```

Bounded contexts:

| Context | Responsibility | Main types |
|---|---|---|
| Patient care | Patients, wounds, assessments, measurements | `Patient`, `Wound` |
| Tasking | Dressing changes and visits | `CareTask` |
| Clinical interop | FHIR R4 projection and reads | `FhirResource` |
| Analytics | Metric catalog, semantic graph, SQL templates | `MetricDefinition` |
| Risk scoring | Feature vector and score history | `RiskScore` |

Patient care is upstream. Clinical interop follows FHIR R4 as the published language. Analytics reads a flattened projection (the anti-corruption layer), not the FHIR documents. Risk scoring takes features from patient care and returns a score on the API.

Domain events: `WoundAssessed`, `MeasurementRecorded`, `CareTaskCompleted`, `RiskScoreComputed`, `FhirResourcePublished`.

Locally those events stay on an in-process bus and the FHIR mapper runs in the same process. The CDK stack sends `WoundAssessed` to a Lambda that PUTs the same resources to HealthLake.

## What the API serves

FHIR R4 reads, JSON:

- `GET /fhir/r4/metadata`
- `GET /fhir/r4/Patient/{id}` and search by `name`, `identifier`
- `GET /fhir/r4/Observation` search by `patient`, `code`, `category`
- `GET /fhir/r4/Condition`, `Encounter`, `Task`

Clinical and operational routes:

- `GET /api/v1/patients/{id}/summary`
- `POST /api/v1/wounds/{id}/assessments`
- `GET /api/v1/tasks`
- `POST /api/v1/tasks/{id}/complete`
- `GET /api/v1/patients/{patientId}/wounds/{woundId}/risk`
- `GET /api/v1/metrics`
- `POST /api/v1/analytics/query`
- `GET /api/v1/audit`

`GET /health` is open. Every other route needs a bearer token. PHI routes also need `X-Purpose-Of-Use`: `treatment`, `payment`, or `operations`. The role caps which purposes are accepted. A clinician can use `treatment`. A partner can use `payment` or `operations`. An analyst can use `operations` and cannot read FHIR patient resources.

| Role | Can do |
|---|---|
| clinician | FHIR and summary reads inside granted facilities, assessments, task completion, risk scores |
| patient | The same reads for their own patient id |
| partner | FHIR reads across the tenant |
| analyst | Metric catalog and templated queries for the tenant |
| auditor | The audit log |

Tokens are RS256. Locally they are signed with a dev key (`npm run keys`, `npm run token -- clinician`). In the CDK stack the issuer is a Cognito user pool and the API verifies the JWKS. Groups are `cognito:groups`. Tenant, facility, and patient claims are `custom:tenant_id`, `custom:facility_ids`, and `custom:patient_id`.

Every PHI read writes an audit record: actor, role, tenant, action, resource type, resource ids, purpose, outcome, and the names of query parameters. The record does not store names, birth dates, or MRNs. Application logs pass through the same redaction before they are written.

## Analytics

Callers send a structured request, not SQL:

```json
{
  "metric": "healing_rate_30d",
  "dimensions": ["facility_id"],
  "filters": { "wound_type": "pressure-injury" },
  "timeRange": { "start": "2026-09-01", "end": "2026-11-01" }
}
```

`search` is optional. It matches a metric only through a fixed synonym list (`healing rate`, `overdue dressing`, `caseload`, `area change`, `visit adherence`). An unknown phrase or two matching metrics is rejected.

Each metric has an owner, a grain, a fact table, allowed dimensions, allowed filters, and one reviewed SQL template. The builder injects `tenant_id`, the caller's facility scope when they have one, a row limit, and only allow-listed identifiers. Filter values are bound parameters. The rendered statement is checked again for a tenant predicate, a single table from the catalog, and the absence of statement separators.

The semantic graph (metric, table, dimension, filter) is built from that catalog. `toOpenCypher` prints the load statements a Neptune cluster would run. Locally the graph is in memory. The CDK stack creates the Neptune cluster; this process does not open a graph connection.

Metrics on the synthetic snapshot dated `2026-10-15`:

| Metric | Meaning on this cohort |
|---|---|
| `healing_rate_30d` | Share of wounds with at least a 40% area reduction, or closure. Harbor is 0.5, Ridge is 1. |
| `overdue_dressing_changes` | Open dressing-change tasks due in the window. Harbor has 2. |
| `clinician_caseload` | Distinct open wounds per clinician. |
| `mean_area_change_14d` | Mean area-change ratio on the snapshot. |
| `visit_adherence` | Completed tasks divided by tasks due in the window. |

Those figures are the fixture, counted by the tests. They are not clinic results.

Local execution uses SQLite against the same SQL text. Athena is the deployed engine: a workgroup with a 100 MB scan cutoff and a separate results bucket. The Athena adapter binds parameters by escaping literals because the Athena data API does not use SQLite placeholders.

## Risk scores

Features are wound type, area change, comorbidity count, visit adherence, baseline area, depth, tissue type, and offloading. The local scorer is a fixed formula, model version `reference-heuristic-0.1.0`. It is not a trained model. The SageMaker client sends the same JSON feature object to an endpoint and reads back `score` and `modelVersion`.

Responses always include `decisionSupportOnly: true` and a disclaimer that the score does not start, stop, or change care. On the seeded cohort, wound `wound-1006` lands in the high band and wound `wound-1001` lands in the low band.

## Synthetic cohort

Six fictional patients across two facilities, `fac-harbor` and `fac-ridge`, tenant `tenant-demo`. MRNs look like `SYN-1001`. Names and dates are made up. A one-line NDJSON sample lives in `data/synthetic/export.ndjson` for the lakehouse transform.

## Run it

Requirements: Node.js 22. Docker is only needed for Compose. Python 3 runs the lakehouse unit test.

```bash
npm install
npm test
npm run keys
npm start
```

`npm start` listens on port 3000 after `npm run build`, or use `npm run start:dev` without a build. Dev keys are written to `dev-keys/` and are gitignored. They are for this local issuer only.

```bash
eval "$(npm run token --silent -- clinician | tail -n 1 | awk '{print "TOKEN="$0}')"
curl -s localhost:3000/fhir/r4/Patient/pat-1001 \
  -H "authorization: Bearer $TOKEN" \
  -H "x-purpose-of-use: treatment"

npm run token --silent -- analyst
# then POST /api/v1/analytics/query with purpose operations
```

Other token roles: `patient`, `partner`, `auditor`.

Compose starts LocalStack (S3 and DynamoDB), Redis, Postgres with the Aurora schema loaded, and the API. The API uses the in-memory FHIR store and SQLite analytics, and when `AWS_ENDPOINT_URL` is set it writes audit objects to S3 and idempotency keys to DynamoDB.

```bash
docker compose up --build
```

Postgres in Compose is there so the transactional schema can be inspected. The Node process does not use it. See the trade-off below.

## Tests and CI

```bash
npm run lint
npm test
npm run build
npm run synth
python -m unittest discover -s services/lakehouse -t services/lakehouse
```

GitHub Actions runs the same steps. `cdk synth` uses a placeholder account (`123456789012`) and committed availability zones, so it does not call AWS.

## Infrastructure

`infra/lib/wound-care-stack.ts` is the deployed shape:

- VPC with private subnets, S3 and DynamoDB gateway endpoints, and interface endpoints for HealthLake, Athena, Glue, KMS, and SageMaker Runtime
- KMS key, S3 zones (raw, curated, features, models, Athena results), audit bucket with Object Lock
- Aurora PostgreSQL Serverless v2, ElastiCache Redis, Neptune, HealthLake R4
- Glue database and Parquet tables, Glue job, Athena workgroup
- Cognito user pool and groups, HTTP API in front of the Fargate service
- EventBridge bus, archive, Lambda mapper, SQS dead-letter queue
- SageMaker model, endpoint, and feature group
- Lake Formation `SELECT` for the task role on `curated_wound_outcomes`, excluding `patient_id`

`npx cdk synth` does not build a container. The task image defaults to the public Node 22 image so synthesis works without Docker. That image does not contain this service. Build `Dockerfile`, push it, and pass the URI:

```bash
npx cdk synth -c apiImage=123456789012.dkr.ecr.us-east-1.amazonaws.com/woundcare-api:latest
```

Before a real deploy you would also upload `services/lakehouse/flatten_export.py` to the curated bucket key the Glue job expects, and upload a `model.tar.gz` for the endpoint. Neither object is created by synth.

## Design choices

**One process locally, several services in the stack.** The bounded contexts are modules with their own types and ports. Splitting them into separate deployables would add network failure modes without teaching more about the data flow. The stack still shows the Lambda mapper, HealthLake, Athena, and the SageMaker endpoint as separate resources.

**Templates instead of free-form SQL.** The analyst request cannot introduce a table, a column, or a second statement. That is stricter than letting a caller edit SQL, and it is testable: each template has a golden string and the cohort has expected rates.

**In-memory system of record.** Aurora is in the stack and `infra/sql/aurora-schema.sql` is the transactional schema, including an event table. The running API keeps aggregates in memory so `npm test` stays hermetic. A Postgres adapter would be the next port on `PatientCareRepository` and `TaskRepository`.

**Reference scorer.** Training a model on six synthetic wounds would not mean anything. The endpoint contract is what the tests lock: feature JSON in, score and model version out, disclaimer always attached. The circuit breaker around Athena and the endpoint fails closed after repeated errors.

**Facility scope on the token.** Clinicians only see facilities listed on the token. A direct read of another facility is denied and audited. Searches drop rows the caller cannot see.

**Idempotent FHIR ids.** Observation ids are `obs-{assessmentId}-{code}`. Replaying the mapper overwrites the same resource and bumps `meta.versionId`. Assessment writes accept `Idempotency-Key`.

## Layout

```
src/contexts/patient-care     wounds and patients
src/contexts/tasking          care tasks
src/contexts/clinical-interop FHIR mapping and stores
src/contexts/analytics        catalog, graph, SQL, SQLite and Athena engines
src/contexts/risk             features and scorers
src/api                       HTTP, authz, audit on the way out
src/seed                      synthetic cohort
services/fhir-mapper          Lambda entry
services/lakehouse            NDJSON flatten used by the Glue job
infra                         CDK app and Aurora schema
docs/architecture.html        architecture diagram
```

## Design targets

Not measured. They are the budgets the stack is aimed at, from the diagram notes.

| Path | Target |
|---|---|
| FHIR read, one resource | p95 under 300 ms |
| Cached patient summary | p95 under 150 ms |
| Risk score | p95 under 200 ms |
| Templated analytics query | p95 under 10 s |
| Event to FHIR store | under 60 s |
| API availability | 99.9% monthly |

## Related public write-ups

These describe similar AWS building blocks. They are not endorsements and this repository is not affiliated with them.

- [MEDHOST migrating electronic health record data to AWS](https://aws.amazon.com/blogs/machine-learning/how-medhost-is-migrating-electronic-health-record-data-to-aws-for-compliance-and-gaining-valuable-insights/) (HealthLake, S3, Glue, Athena)
- [WestCare on AWS](https://aws.amazon.com/blogs/publicsector/westcare-uses-aws-to-give-clinicians-more-time-to-focus-on-healing/) (Glue, S3, HealthLake)

## License

MIT. See [LICENSE](LICENSE).
