CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TYPE app_status AS ENUM ('DRAFT','SUBMITTED','EXTRACTING','NEEDS_INFO','VERIFYING','IN_REVIEW','APPROVED','PROVISIONING_FAILED','ACTIVATED','REJECTED');
CREATE TYPE check_status AS ENUM ('PENDING','IN_PROGRESS','PASSED','FAILED','TIMED_OUT','ERROR');
CREATE TYPE attempt_status AS ENUM ('QUEUED','AWAITING_CALLBACK','COMPLETED','TIMED_OUT','DISPATCH_FAILED','SUPERSEDED');
CREATE SEQUENCE application_reference;
CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL,password_hash text NOT NULL,role text NOT NULL CHECK(role IN ('MERCHANT','OPERATOR')),display_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE applications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference text UNIQUE NOT NULL DEFAULT ('APP-'||lpad(nextval('application_reference')::text,6,'0')),
 owner_user_id uuid NOT NULL REFERENCES users(id),status app_status NOT NULL DEFAULT 'DRAFT',status_changed_at timestamptz NOT NULL DEFAULT now(),data_version integer NOT NULL DEFAULT 0,
 legal_name text NOT NULL,form_enc text NOT NULL,pan_bidx text,gstin_bidx text,bank_account_bidx text,
 submitted_at timestamptz,approved_at timestamptz,approved_by uuid REFERENCES users(id),decision_note text,rejection_reason_code text,
 idempotency_key text,request_hash text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,idempotency_key)
);
CREATE INDEX ON applications(status,status_changed_at);
CREATE INDEX ON applications(owner_user_id);
CREATE INDEX ON applications(pan_bidx);
CREATE INDEX ON applications(gstin_bidx);
CREATE INDEX ON applications(bank_account_bidx);
CREATE TABLE documents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),doc_type text NOT NULL CHECK(doc_type IN ('PAN_CARD','GST_CERTIFICATE','BANK_PROOF')),
 source text NOT NULL CHECK(source IN ('FILE','STRUCTURED')),file_name text,mime_type text,size_bytes integer,sha256 text,storage_key text,payload_enc text,
 is_active boolean NOT NULL DEFAULT true,extraction_status text NOT NULL DEFAULT 'PENDING' CHECK(extraction_status IN ('PENDING','COMPLETED','FAILED')),
 extractor text,legibility text,detected_doc_type text,extraction_model text,extracted_at timestamptz,uploaded_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON documents(application_id,doc_type) WHERE is_active;
CREATE TABLE extracted_fields(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES documents(id),application_id uuid NOT NULL REFERENCES applications(id),field_name text NOT NULL,value_enc text NOT NULL,confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1),validation text,UNIQUE(document_id,field_name));
CREATE TABLE validation_findings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),data_version integer NOT NULL,rule_code text NOT NULL,field_name text,doc_type text,severity text NOT NULL CHECK(severity IN ('BLOCKING','REVIEW','INFO')),passed boolean NOT NULL,message text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON validation_findings(application_id,data_version);
CREATE TABLE info_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','FULFILLED','CANCELLED')),source text NOT NULL,requested_by uuid REFERENCES users(id),items jsonb NOT NULL,note text,fulfilled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE check_policies(check_type text PRIMARY KEY CHECK(check_type IN ('PAN','GST','BANK','RISK')),enabled boolean NOT NULL DEFAULT true,required boolean NOT NULL DEFAULT true,depends_on text[] NOT NULL DEFAULT '{}',timeout_seconds numeric NOT NULL DEFAULT 15 CHECK(timeout_seconds>0),max_attempts integer NOT NULL DEFAULT 2 CHECK(max_attempts>0));
INSERT INTO check_policies(check_type,depends_on) VALUES('PAN','{}'),('GST','{}'),('BANK','{}'),('RISK','{PAN,GST,BANK}');
CREATE TABLE verification_checks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),check_type text NOT NULL REFERENCES check_policies(check_type),status check_status NOT NULL DEFAULT 'PENDING',cycle integer NOT NULL DEFAULT 1,input_hash text NOT NULL,result jsonb,reason_code text,completed_at timestamptz,UNIQUE(application_id,check_type));
CREATE TABLE check_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),check_id uuid NOT NULL REFERENCES verification_checks(id),application_id uuid NOT NULL REFERENCES applications(id),cycle integer NOT NULL,attempt_no integer NOT NULL,status attempt_status NOT NULL DEFAULT 'QUEUED',input_hash text NOT NULL,provider_request_id text,dispatched_at timestamptz,deadline_at timestamptz,completed_at timestamptz,result jsonb,last_error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(check_id,attempt_no));
CREATE UNIQUE INDEX ON check_attempts(check_id) WHERE status IN ('QUEUED','AWAITING_CALLBACK');
CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL,event_id text NOT NULL,client_reference_id uuid NOT NULL,attempt_id uuid REFERENCES check_attempts(id),application_id uuid REFERENCES applications(id),payload jsonb NOT NULL,outcome text NOT NULL CHECK(outcome IN ('APPLIED','LATE','STALE','ALREADY_COMPLETED','UNMATCHED')),delivery_count integer NOT NULL DEFAULT 1,first_received_at timestamptz NOT NULL DEFAULT now(),last_received_at timestamptz NOT NULL DEFAULT now(),UNIQUE(provider,event_id));
CREATE TABLE application_exceptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),type text NOT NULL,severity text NOT NULL DEFAULT 'HIGH',status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED','SUPERSEDED')),dedupe_key text NOT NULL,details jsonb NOT NULL DEFAULT '{}',raised_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,resolved_by uuid REFERENCES users(id),resolution text,resolution_note text);
CREATE UNIQUE INDEX ON application_exceptions(application_id,dedupe_key) WHERE status='OPEN';
CREATE TABLE duplicate_matches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES applications(id),matched_application_id uuid NOT NULL REFERENCES applications(id),match_type text NOT NULL,score numeric NOT NULL DEFAULT 1,UNIQUE(application_id,matched_application_id,match_type));
CREATE TABLE merchants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL UNIQUE REFERENCES applications(id),merchant_id text NOT NULL UNIQUE,capabilities jsonb NOT NULL,provisioned_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs(id bigserial PRIMARY KEY,type text NOT NULL CHECK(type IN ('INTAKE','DISPATCH_CHECK','CHECK_TIMEOUT','PROVISION_MERCHANT')),application_id uuid REFERENCES applications(id),payload jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','DEAD')),attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 4,run_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,lease_token uuid,last_error text,dedupe_key text,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON jobs(status,run_at);
CREATE UNIQUE INDEX ON jobs(dedupe_key) WHERE status IN ('PENDING','RUNNING');
CREATE TABLE audit_events(id bigserial PRIMARY KEY,application_id uuid REFERENCES applications(id),event_type text NOT NULL,actor_type text NOT NULL,actor_id text,from_status text,to_status text,data jsonb NOT NULL DEFAULT '{}',correlation_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON audit_events(application_id,id);
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_audit();
-- Simulator delivery and idempotency records also survive process restarts.
CREATE TABLE mock_scenarios(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),rule jsonb NOT NULL,remaining integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE mock_requests(id text PRIMARY KEY,provider text NOT NULL,application_id uuid NOT NULL,response jsonb NOT NULL,callback jsonb,callback_url text,run_at timestamptz,remaining_deliveries integer NOT NULL DEFAULT 0,delivery_attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE mock_merchants(application_id uuid PRIMARY KEY,merchant_id text UNIQUE NOT NULL);
INSERT INTO schema_migrations(version) VALUES(1);
